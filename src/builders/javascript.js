import fs from "node:fs/promises";
import path from "node:path";

import { EktoKitError } from "../errors.js";

/**
 * Concatenates each declared JavaScript entry into one bundle, in the order the
 * inputs are written.
 *
 * Both modes parse with Terser, so both agree on what valid JavaScript is and
 * an error names the source file rather than an offset in the bundle. What
 * differs is the output: production takes the code Terser emits, minified;
 * development discards it and keeps the source exactly as written.
 *
 * @param {import("../context.js").Context} ctx
 */
export function createJavaScriptBuilder(ctx) {
    /** @type {typeof import("terser") | null} */
    let terser = null;

    // Both modes go through Terser, so both agree on what valid JavaScript is.
    // Load it only when an entry needs building, then reuse the module.
    async function getTerser() {
        terser ??= await import("terser");
        return terser;
    }

    /**
     * Separates two files the way Terser does when it emits them as one
     * program. Without it a file ending in an expression and a next one
     * opening with `(` or `[` join into a call — valid syntax that does the
     * wrong thing, and only in development, where nothing re-emits the code.
     */
    const FILE_SEPARATOR = "\n;\n";

    /**
     * @param {import("../config.js").EktoKitConfig["js"]["entries"][number]} entry
     */
    async function buildEntry(entry) {
        const started = performance.now();

        /** @type {Record<string, string>} */
        const sources = {};

        // Array order is the concatenation order.
        for (const [index, inputPath] of entry.inputPaths.entries()) {
            try {
                sources[entry.inputs[index]] = await fs.readFile(inputPath, "utf8");
            } catch (cause) {
                if (cause instanceof Error && /** @type {any} */ (cause).code === "ENOENT") {
                    throw new EktoKitError(`JS input not found: ${entry.inputs[index]}`, { cause });
                }

                throw new EktoKitError(`JS input could not be read: ${entry.inputs[index]}`, {
                    detail: cause instanceof Error ? cause.message : String(cause),
                    cause,
                });
            }
        }

        const { minify } = await getTerser();

        let code;

        // Named sources preserve filenames in parse errors in both modes.
        // Production uses Terser's output; development keeps the source text.
        //
        // Minification is production-only, with no per-entry opt-out.
        if (ctx.mode === "production") {
            // Terser throws on a parse error and always resolves with a
            // string, so its own failure is the only one to catch.
            const result = await minify(sources, { sourceMap: false });

            code = /** @type {string} */ (result.code);
        } else {
            // Parse only. Terser regenerates code from the AST, which would
            // reformat the theme's own source and expand every vendor that
            // ships minified — so development keeps the text as written and
            // uses Terser purely to agree with production on what parses.
            await minify(sources, { compress: false, mangle: false, format: { code: false } });

            code = Object.values(sources)
                .map((source) => source.replace(/\n+$/, ""))
                .filter((source) => source !== "")
                .join(FILE_SEPARATOR);

            if (code !== "") code += "\n";
        }

        await fs.mkdir(path.dirname(entry.outputPath), { recursive: true });
        await fs.writeFile(entry.outputPath, code, "utf8");

        return {
            label: "JS",
            name: path.basename(entry.output),
            ms: performance.now() - started,
        };
    }

    return {
        /**
         * Builds the selected JavaScript entries in declaration order. Commands
         * omit the argument and get a complete build; the watcher supplies only
         * the entries affected by the files that changed.
         *
         * @param {import("../config.js").EktoKitConfig["js"]["entries"]} [entries]
         * @returns {Promise<import("../context.js").TaskResult[]>}
         */
        async build(entries = ctx.config.js.entries) {
            const results = [];

            for (const entry of entries) {
                try {
                    results.push(await buildEntry(entry));
                } catch (cause) {
                    // Each entry is its own bundle, so each one fails on its
                    // own and the entries after it are still generated. The
                    // error travels in the result rather than throwing, so the
                    // caller sees every entry of the run; `runTasks` turns the
                    // first one back into a throw for `build` and `zip`.
                    results.push({
                        label: "JS",
                        name: path.basename(entry.output),
                        error: cause instanceof EktoKitError ? cause : jsBuildError(entry, cause),
                    });
                }
            }

            return results;
        },
    };
}

/**
 * The error for one entry that did not build, named by the source file that
 * failed rather than by the bundle it was going into.
 *
 * @param {import("../config.js").EktoKitConfig["js"]["entries"][number]} entry
 * @param {unknown} cause
 */
function jsBuildError(entry, cause) {
    const { where, reason } = describeTerserError(cause);

    return new EktoKitError(`JS build failed: ${where ?? entry.output}`, {
        detail: reason,
        cause,
    });
}

/**
 * Splits a Terser parse error into where it is and what it says.
 *
 * It already carries both, on properties rather than in the message, so
 * without this the terminal says what is wrong and never says where. The file
 * it names is the source file, not the bundle — the same rule the CSS builder
 * follows.
 *
 * @param {unknown} error
 * @returns {{ where: string | null, reason: string }}
 */
function describeTerserError(error) {
    if (error && typeof error === "object" && "filename" in error && "line" in error) {
        const parseError = /** @type {{ message: string, filename: string, line: number }} */ (error);

        return { where: `${parseError.filename}:${parseError.line}`, reason: parseError.message };
    }

    return { where: null, reason: error instanceof Error ? error.message : String(error) };
}
