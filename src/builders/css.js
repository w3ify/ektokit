import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import postcss from "postcss";
import postcssImport from "postcss-import";
import { transform as lightningcssTransform } from "lightningcss";

import { pathKey } from "../config.js";
import { EktoKitError } from "../errors.js";

const TAILWIND_PACKAGES = ["tailwindcss", "@tailwindcss/postcss"];

/**
 * Resolves the Tailwind PostCSS plugin from the *theme*, not from this package,
 * so a vanilla theme never needs Tailwind installed at all.
 *
 * @param {string} root the theme root
 * @param {"development" | "production"} mode
 */
async function loadTailwindPlugin(root, mode) {
    const require = createRequire(path.join(root, "package.json"));
    const missing = [];

    for (const name of TAILWIND_PACKAGES) {
        try {
            require.resolve(name);
        } catch {
            missing.push(name);
        }
    }

    if (missing.length > 0) {
        throw new EktoKitError(
            "Tailwind processor is enabled, but the required Tailwind dependencies were not found.",
            {
                detail: `Missing: ${missing.join(", ")}`,
                hint: "Install them with:\n\nnpm install -D tailwindcss @tailwindcss/postcss",
            },
        );
    }

    const resolved = require.resolve("@tailwindcss/postcss");

    let module;

    try {
        module = await import(pathToFileURL(resolved).href);
    } catch (cause) {
        throw new EktoKitError("Unable to load @tailwindcss/postcss", {
            detail: cause instanceof Error ? cause.message : String(cause),
            hint: "Reinstall the Tailwind dependencies:\n\nnpm install -D tailwindcss @tailwindcss/postcss",
            cause,
        });
    }

    const plugin = module.default ?? module;

    if (typeof plugin !== "function") {
        throw new EktoKitError("@tailwindcss/postcss did not export a PostCSS plugin", {
            detail: `Expected a function, received ${plugin === null ? "null" : typeof plugin}.\nLoaded from: ${resolved}`,
            hint: "This is what a version mismatch looks like. Check the installed version:\n\nnpm ls @tailwindcss/postcss",
        });
    }

    // `base` anchors Tailwind's automatic source detection to the theme root,
    // regardless of the directory the command was started from.
    return plugin({ base: root, optimize: mode === "production" });
}

/**
 * Captures `console.error` for the duration of a build and replays it only if
 * the build succeeds.
 *
 * The Tailwind plugin dumps the raw error object before throwing, which would
 * bury the readable message. Genuine warnings still reach the terminal.
 *
 * @template T
 * @param {() => Promise<T>} run
 */
async function withQuietConsole(run) {
    const original = console.error;
    /** @type {unknown[][]} */
    const captured = [];

    console.error = (...args) => captured.push(args);

    let value;

    try {
        value = await run();
    } finally {
        console.error = original;
    }

    for (const args of captured) original(...args);

    return value;
}

/**
 * Builds each declared CSS entry into its own stylesheet.
 *
 * The processor is cached per builder instance and reused across rebuilds.
 * Successful builds record each entry's `@import` dependencies so vanilla CSS
 * rebuilds can target entries affected by a changed stylesheet.
 *
 * @param {import("../context.js").Context} ctx
 */
export function createCssBuilder(ctx) {
    /** @type {Promise<import("postcss").Processor> | null} */
    let processorPromise = null;

    /**
     * Which files each entry actually read, learned from the build itself.
     *
     * `postcss-import` reports every file it pulled in, at any depth, so the
     * graph is a by-product of compiling rather than a parser of our own. A
     * shared partial is therefore known to belong to each entry that imports
     * it, which is what lets a save rebuild only the entries that read it.
     *
     * An entry is absent from this map until it has built successfully, and is
     * removed again when it fails — an unfinished build's graph cannot be
     * trusted, so those entries are included whenever a change schedules CSS.
     *
     * @type {Map<(typeof ctx.config.css.entries)[number], Set<string>>}
     */
    const readsByEntry = new Map();

    // Create the processor lazily and reuse it within this builder.
    function getProcessor() {
        processorPromise ??= (async () => {
            const plugins =
                ctx.config.css.processor === "tailwind"
                    ? [await loadTailwindPlugin(ctx.root, ctx.mode)]
                    // Assembles @import into one stylesheet, the job Tailwind's
                    // own bundler does on the other path. It also forces a real
                    // parse, so a broken file is reported, not copied through.
                    : [postcssImport()];

            return postcss(plugins);
        })();

        return processorPromise;
    }

    /**
     * @param {import("../config.js").EktoKitConfig["css"]["entries"][number]} entry
     */
    async function buildEntry(entry) {
        const started = performance.now();

        let source;

        try {
            source = await fs.readFile(entry.inputPath, "utf8");
        } catch (cause) {
            if (cause instanceof Error && /** @type {any} */ (cause).code === "ENOENT") {
                throw new EktoKitError(`CSS input not found: ${entry.input}`, { cause });
            }

            throw new EktoKitError(`CSS input could not be read: ${entry.input}`, {
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
            });
        }

        const processor = await getProcessor();

        let result;

        try {
            result = await withQuietConsole(() =>
                processor.process(source, {
                    from: entry.inputPath,
                    to: entry.outputPath,
                    map: false,
                }),
            );
        } catch (cause) {
            // Named by the file that failed, not by the entry being built: one
            // broken partial breaks every entry importing it, and naming the
            // entry would point at a file that is perfectly fine.
            const { where, reason } = describePostcssError(cause, ctx.root);

            throw new EktoKitError(`CSS build failed: ${where ?? entry.input}`, {
                detail: reason,
                cause,
            });
        }

        // Tailwind minifies itself through `optimize`, above. Vanilla has no
        // such built-in, so lightningcss runs as a separate step on the
        // assembled stylesheet — production only, like Terser for JavaScript.
        let css = result.css;

        if (ctx.config.css.processor === "vanilla" && ctx.mode === "production") {
            try {
                css = lightningcssTransform({
                    filename: entry.outputPath,
                    code: Buffer.from(css, "utf8"),
                    minify: true,
                }).code.toString("utf8");
            } catch (cause) {
                throw new EktoKitError(`CSS minification failed: ${entry.input}`, {
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                });
            }
        }

        await fs.mkdir(path.dirname(entry.outputPath), { recursive: true });
        await fs.writeFile(entry.outputPath, css, "utf8");

        // Recorded only now, so a graph exists only for an entry whose output
        // is actually on disk. The input itself counts as read: it is the file
        // the entry is declared with.
        readsByEntry.set(
            entry,
            new Set([
                pathKey(entry.inputPath),
                ...result.messages
                    .filter((message) => message.type === "dependency" && message.file)
                    .map((message) => pathKey(message.file)),
            ]),
        );

        return {
            label: "CSS",
            name: path.basename(entry.output),
            ms: performance.now() - started,
        };
    }

    return {
        /**
         * Builds the supplied CSS entries, defaulting to all configured entries.
         *
         * Each entry is its own output file, so each one fails on its own: a
         * stylesheet that stops parsing does not stop the entries after it from
         * being generated. Whatever an entry pulls in through `@import` is part
         * of that entry, not a unit of its own.
         *
         * A failed entry comes back carrying its error instead of throwing, so
         * the caller sees every entry of the run. `runTasks` turns the first
         * one back into a throw, because `build` and `zip` must still stop.
         *
         * @param {import("../config.js").EktoKitConfig["css"]["entries"]} [entries]
         * @returns {Promise<import("../context.js").TaskResult[]>}
         */
        async build(entries = ctx.config.css.entries) {
            const results = [];

            for (const entry of entries) {
                try {
                    results.push(await buildEntry(entry));
                } catch (error) {
                    // Retry this entry on the next change that schedules CSS,
                    // since a failed build cannot provide a complete graph.
                    readsByEntry.delete(entry);

                    results.push({
                        label: "CSS",
                        name: path.basename(entry.output),
                        error,
                    });
                }
            }

            return results;
        },

        /**
         * The entries a saved file belongs to, for the watcher to rebuild.
         *
         * Vanilla assembles each entry from its own `@import` tree, so a save
         * touches only the entries that read that file. In Tailwind mode,
         * stylesheet changes rebuild every entry because generated utilities
         * also depend on scanned content.
         *
         * An entry with no recorded graph is always included — it has never
         * built, or its last build failed, so there is nothing trustworthy to
         * exclude it by.
         *
         * @param {string} file absolute path of the saved file
         */
        entriesFor(file) {
            if (ctx.config.css.processor === "tailwind") return ctx.config.css.entries;

            const key = pathKey(file);

            return ctx.config.css.entries.filter((entry) => {
                const reads = readsByEntry.get(entry);

                return reads === undefined || reads.has(key);
            });
        },
    };
}

/**
 * Splits a PostCSS syntax error into where it is and what it says.
 *
 * It already carries both, on properties rather than in the message, and a
 * stack trace would bury them. The file it names is the one that failed to
 * parse — which, with `@import`, is often a partial rather than the entry
 * being built, and is the file the author has to open.
 *
 * @param {unknown} error
 * @param {string} root the theme root
 * @returns {{ where: string | null, reason: string }}
 */
function describePostcssError(error, root) {
    if (error && typeof error === "object" && "reason" in error && "file" in error) {
        const cssError = /** @type {import("postcss").CssSyntaxError} */ (error);
        const file = cssError.file
            ? path.relative(root, cssError.file).split(path.sep).join("/")
            : null;

        return {
            where: file ? `${file}${cssError.line ? `:${cssError.line}` : ""}` : null,
            reason: trimSearchPaths(cssError.reason),
        };
    }

    return { where: null, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * The list of directories `postcss-import` searched, which it appends to a
 * failed resolve:
 *
 *     Failed to find './parts/tokens.css'
 *       in [
 *         /theme/assets/css
 *       ]
 *
 * A relative import has one place it could have looked — the folder of the file
 * doing the importing, which the headline already names — so the list is three
 * lines saying nothing, and on Windows an absolute path long enough to bury the
 * message it belongs to.
 *
 * Only this exact shape is trimmed. It is somebody else's message, so anything
 * that does not match passes through whole rather than being guessed at.
 */
const SEARCH_PATHS = /\n[ \t]*in \[\n[\s\S]*\n[ \t]*\]$/;

/**
 * @param {string} reason
 */
export function trimSearchPaths(reason) {
    return reason.replace(SEARCH_PATHS, "");
}
