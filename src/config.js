import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EktoKitError } from "./errors.js";

/**
 * The config file. `.mjs` is an ES module whatever the theme's `package.json`
 * says, so a Ghost theme runs the CLI exactly as Ghost ships it.
 */
export const CONFIG_FILENAME = "ektokit.config.mjs";

/**
 * How a file at the theme root is written in a message.
 *
 * A terminal turns a path into a clickable link by recognising it as a path,
 * and a bare name has nothing to recognise — `assets/css/style.css` is spotted
 * by its slashes, `ektokit.config.mjs` is not. The `./` supplies one, and the
 * commands run from the theme root, so the message opens the file.
 *
 * This is the same mechanism that already makes an asset error clickable, not
 * a second one: no escape sequence, nothing to support, and a terminal that
 * does not detect paths is left with two inert characters.
 *
 * @param {string} name
 */
function atThemeRoot(name) {
    return `./${name}`;
}

/** The config file as messages name it. */
export const CONFIG_PATH = atThemeRoot(CONFIG_FILENAME);

/** The theme manifest as messages name it. */
export const PACKAGE_PATH = atThemeRoot("package.json");

const CSS_PROCESSORS = new Set(["tailwind", "vanilla"]);

const DEFAULT_SERVER = {
    proxy: "http://localhost:2368",
    port: 3000,
    host: false,
};

/** The one release directory. It is convention, not public configuration. */
const ZIP_OUTPUT_DIRNAME = "dist";

/** Characters no portable file name may carry. */
const ILLEGAL_IN_ARCHIVE_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

/** Device names that remain reserved even when a file extension is present. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Normalizes one archive name and refuses anything that is not a portable file
 * stem. The `.zip` extension is owned by the tool and appended later.
 *
 * @param {string} subject
 * @param {unknown} raw
 * @returns {string} the trimmed name
 */
export function normalizeArchiveName(subject, raw) {
    const value = assertPlainNonEmptyString(subject, raw);
    const hint = 'Use a name such as "my-theme", without a path or the .zip extension.';

    if (value.includes("/") || value.includes("\\")) {
        throw new EktoKitError(`${subject} must be a file name, not a path`, {
            detail: `Received: ${JSON.stringify(value)}`,
            hint,
        });
    }

    if (value.toLowerCase().endsWith(".zip")) {
        throw new EktoKitError(`${subject} must not include the .zip extension`, {
            detail: `Received: ${JSON.stringify(value)}`,
            hint,
        });
    }

    if (
        value === "." ||
        value === ".." ||
        ILLEGAL_IN_ARCHIVE_NAME.test(value) ||
        /^[. ]|[. ]$/.test(value) ||
        WINDOWS_RESERVED_NAME.test(value)
    ) {
        throw new EktoKitError(`${subject} is not a valid portable file name`, {
            detail: `Received: ${JSON.stringify(value)}`,
            hint,
        });
    }

    return value;
}

/**
 * The directory Ghost serves theme files from, and the base every path under
 * `assets` resolves against. Ghost's own `{{asset "built/style.css"}}` omits it
 * for the same reason.
 */
const ASSETS_DIRNAME = "assets";

/**
 * Resolves a path and lowercases it for case-insensitive identity comparisons.
 * This does not change filesystem access or glob extension matching.
 *
 * @param {string} file
 */
export function pathKey(file) {
    return path.resolve(file).toLowerCase();
}

/**
 * @param {string} file
 */
async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Loads the config from the project root.
 *
 * @param {string} root absolute project root
 * @returns {Promise<{ config: unknown, file: string }>}
 */
export async function loadConfig(root) {
    const file = path.join(root, CONFIG_FILENAME);

    if (!(await exists(file))) {
        throw new EktoKitError(`No ${CONFIG_FILENAME} found in ${root}`, {
            hint: `Create ${CONFIG_FILENAME} in the theme root and run the command from there.`,
        });
    }

    let module;

    try {
        // The query defeats the ESM cache, so a long-running process can
        // re-import the file.
        module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    } catch (cause) {
        throw new EktoKitError(`Unable to load ${CONFIG_PATH}`, {
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
        });
    }

    const config = module.default;

    if (config === undefined) {
        throw new EktoKitError(`${CONFIG_PATH} has no default export`, {
            hint: "Export the configuration object:\n\nexport default {\n    // config\n};",
        });
    }

    if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw new EktoKitError(`${CONFIG_PATH} must export an object`, {
            detail: `Received: ${Array.isArray(config) ? "array" : typeof config}`,
        });
    }

    return { config, file };
}

/**
 * Reads the theme `package.json`. Missing file is not fatal here: only the ZIP
 * name fallback and a couple of messages depend on it.
 *
 * @param {string} root
 */
export async function loadPackageJson(root) {
    const file = path.join(root, "package.json");

    let raw;

    try {
        raw = await fs.readFile(file, "utf8");
    } catch {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (cause) {
        throw new EktoKitError(`Unable to parse ${PACKAGE_PATH}`, {
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
        });
    }
}

/**
 * Names one `assets` field in an error message — by its value when there is
 * one, by its position when there is not.
 *
 * @param {{ section: "css" | "js", index: number, field: "input" | "output" }} at
 * @param {string} [value]
 * @returns {string} e.g. `JS input "js/lib/photoswipe.min.js"`
 */
function describe(at, value) {
    const label = `${at.section === "css" ? "CSS" : "JS"} ${at.field}`;

    return value === undefined ? `${label} in entry ${at.index + 1}` : `${label} ${JSON.stringify(value)}`;
}

/**
 * Asserts a non-empty string and trims it, for fields named exactly as the
 * config spells them.
 *
 * @param {string} subject
 * @param {unknown} value
 * @returns {string} the trimmed value
 */
function assertPlainNonEmptyString(subject, value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new EktoKitError(`${subject} must be a non-empty string`, {
            detail: `Received: ${JSON.stringify(value)}`,
        });
    }

    return value.trim();
}

/**
 * Asserts a non-empty string for one `assets` field and trims it.
 *
 * Whitespace around the value is editing noise. A space at the edge of a path
 * *segment* is a different thing, refused in {@link resolveAsset}.
 *
 * @param {{ section: "css" | "js", index: number, field: "input" | "output" }} at
 * @param {unknown} value
 * @returns {string} the trimmed value
 */
function assertNonEmptyString(at, value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new EktoKitError(`${describe(at)} must be a non-empty string`, {
            detail: `Received: ${JSON.stringify(value)}`,
        });
    }

    return value.trim();
}

/**
 * Resolves one path written relative to the theme's `assets/`, refusing
 * anything ambiguous: outside `assets/`, more than one spelling, or an
 * extension the section does not build.
 *
 * @param {string} root the theme root
 * @param {{ section: "css" | "js", index: number, field: "input" | "output" }} at
 * @param {string} target
 * @returns {{ absolute: string, display: string }} absolute for the builders,
 * display (from the theme root) for the terminal
 */
function resolveAsset(root, at, target) {
    const subject = describe(at, target);

    // A leading `./` is a no-op prefix, so it is normalized rather than
    // refused. A detour that changes the path is not: see the check below.
    const written = target.split(path.sep).join("/").replace(/^\.\//, "");

    // Paths are already relative to assets/, so the prefix would resolve to
    // assets/assets/... and surface later as a puzzling "input not found".
    if (/^\/*assets(\/|$)/.test(written)) {
        const fix = written.replace(/^\/*assets\/?/, "");

        throw new EktoKitError(`${subject} must not start with "assets/"`, {
            hint: fix
                ? `Paths are already relative to assets/. Write "${fix}" instead.`
                : `Paths are already relative to assets/. Write the path from inside it, like "css/style.css".`,
        });
    }

    // A space inside a segment ("css/my file.css") is a legal filename; one at
    // the edge points at a folder nobody meant to name.
    if (written.split("/").some((segment) => segment !== segment.trim())) {
        throw new EktoKitError(`${subject} has a space at the edge of a path segment`, {
            hint: `Write "${written.split("/").map((segment) => segment.trim()).join("/")}" instead.`,
        });
    }

    if (written.endsWith("/")) {
        throw new EktoKitError(`${subject} must be a file, not a directory`, {
            hint: "A trailing slash names a folder; an input and an output are always one file.",
        });
    }

    const extension = at.section === "css" ? ".css" : ".js";

    if (!written.toLowerCase().endsWith(extension)) {
        throw new EktoKitError(`${subject} must be a ${extension} file`, {
            hint: `The ${at.section === "css" ? "CSS" : "JS"} pipeline only builds ${extension} files.`,
        });
    }

    const assetsRoot = path.join(root, ASSETS_DIRNAME);
    const absolute = path.resolve(assetsRoot, target);
    const relative = path.relative(assetsRoot, absolute);

    // `!relative` refuses a path that resolves to assets/ itself (".").
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new EktoKitError(`${subject} must be inside the theme's assets/ directory`, {
            hint: "Every source and output lives under assets/. Write the path from there, like \"css/style.css\".",
        });
    }

    // `../assets/a.css` and `css/../css/a.css` resolve back inside assets/, so
    // they would pass the check above and give one file several spellings.
    const canonical = relative.split(path.sep).join("/");

    if (canonical !== written) {
        throw new EktoKitError(`${subject} must be a plain path relative to assets/`, {
            hint: `It resolves to "${canonical}". Write that instead — one file has one spelling here.`,
        });
    }

    return { absolute, display: toDisplayPath(root, absolute) };
}

/**
 * @param {string} root
 * @param {string} absolute
 */
function toDisplayPath(root, absolute) {
    return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function normalizeServer(value, where) {
    // Defaults must also pass through URL parsing to provide server.proxyUrl.
    if (value === undefined) value = {};

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new EktoKitError(`${where} must be an object`);
    }

    const server = { ...DEFAULT_SERVER, ...value };

    if (typeof server.proxy !== "string" || server.proxy.trim() === "") {
        throw new EktoKitError(`${where}.proxy must be a non-empty string`, {
            detail: `Received: ${JSON.stringify(server.proxy)}`,
        });
    }

    let proxyUrl;

    try {
        proxyUrl = new URL(server.proxy);
    } catch {
        throw new EktoKitError(`${where}.proxy must be a valid URL`, {
            detail: `Received: ${server.proxy}`,
            hint: 'Example: proxy: "http://localhost:2368"',
        });
    }

    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
        throw new EktoKitError(`${where}.proxy must use http or https`, {
            detail: `Received: ${server.proxy}`,
        });
    }

    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
        throw new EktoKitError(`${where}.port must be an integer between 1 and 65535`, {
            detail: `Received: ${JSON.stringify(server.port)}`,
        });
    }

    if (typeof server.host !== "boolean") {
        throw new EktoKitError(`${where}.host must be a boolean`, {
            detail: `Received: ${JSON.stringify(server.host)}`,
        });
    }

    return {
        proxy: server.proxy,
        proxyUrl,
        port: server.port,
        host: server.host,
    };
}

/**
 * @param {unknown} value
 * @param {string} root
 * @param {string} section config path used in validation messages
 */
function normalizeCss(value, root, section) {
    if (value === undefined) return { processor: "vanilla", entries: [] };

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new EktoKitError(`${section} must be an object`);
    }

    const processor = value.processor ?? "vanilla";

    if (!CSS_PROCESSORS.has(processor)) {
        throw new EktoKitError(
            `${section}.processor must be one of: ${[...CSS_PROCESSORS].join(", ")}`,
            { detail: `Received: ${JSON.stringify(processor)}` },
        );
    }

    const entries = value.entries ?? [];

    if (!Array.isArray(entries)) {
        throw new EktoKitError(`${section}.entries must be an array`);
    }

    return {
        processor,
        entries: entries.map((entry, index) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                throw new EktoKitError(`CSS entry ${index + 1} must be an object with "input" and "output"`);
            }

            const inputAt = { section: "css", index, field: "input" };
            const outputAt = { section: "css", index, field: "output" };

            const input = resolveAsset(root, inputAt, assertNonEmptyString(inputAt, entry.input));
            const output = resolveAsset(root, outputAt, assertNonEmptyString(outputAt, entry.output));

            return {
                input: input.display,
                inputPath: input.absolute,
                output: output.display,
                outputPath: output.absolute,
            };
        }),
    };
}

/**
 * @param {unknown} value
 * @param {string} root
 * @param {string} section config path used in validation messages
 */
function normalizeJs(value, root, section) {
    if (value === undefined) return { entries: [] };

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new EktoKitError(`${section} must be an object`);
    }

    const entries = value.entries ?? [];

    if (!Array.isArray(entries)) {
        throw new EktoKitError(`${section}.entries must be an array`);
    }

    return {
        entries: entries.map((entry, index) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                throw new EktoKitError(`JS entry ${index + 1} must be an object with "input" and "output"`);
            }

            const rawInputs = Array.isArray(entry.input) ? entry.input : [entry.input];

            if (rawInputs.length === 0) {
                throw new EktoKitError(`JS entry ${index + 1} must list at least one input file`);
            }

            const inputAt = { section: "js", index, field: "input" };
            const outputAt = { section: "js", index, field: "output" };

            const inputs = rawInputs.map((input) =>
                resolveAsset(root, inputAt, assertNonEmptyString(inputAt, input)),
            );

            const output = resolveAsset(root, outputAt, assertNonEmptyString(outputAt, entry.output));

            return {
                // Array order is the concatenation order.
                inputs: inputs.map((input) => input.display),
                inputPaths: inputs.map((input) => input.absolute),
                concat: Array.isArray(entry.input),
                output: output.display,
                outputPath: output.absolute,
            };
        }),
    };
}

/**
 * @param {unknown} value
 * @param {string} root
 */
function normalizeZip(value, root) {
    if (value === undefined) {
        return {
            name: undefined,
            outputPath: path.resolve(root, ZIP_OUTPUT_DIRNAME),
            ignore: [],
        };
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new EktoKitError("zip must be an object");
    }

    const name = value.name === undefined ? undefined : normalizeArchiveName("zip.name", value.name);

    const ignore = value.ignore ?? [];

    if (!Array.isArray(ignore)) {
        throw new EktoKitError("zip.ignore must be an array of patterns");
    }

    ignore.forEach((pattern, index) => {
        assertPlainNonEmptyString(`zip.ignore[${index}]`, pattern);
    });

    return {
        name,
        outputPath: path.resolve(root, ZIP_OUTPUT_DIRNAME),
        ignore: [...ignore],
    };
}

/**
 * Refuses an `output` that collides with something else: an `input`, which the
 * build would overwrite in place, or another `output`, which the second entry
 * would overwrite silently.
 *
 * Paths are compared resolved and without case — `a.css` and `built/a.css` are
 * different files, `a.css` and `A.css` are not.
 *
 * @param {ReturnType<typeof normalizeCss>} css
 * @param {ReturnType<typeof normalizeJs>} js
 */
function assertNoOutputConflicts(css, js) {
    /** @type {Set<string>} */
    const inputs = new Set();

    // One set for both sections. Validated extensions already keep a `.js`
    // output from matching a `.css` input, so this is defence in depth.
    css.entries.forEach((entry) => inputs.add(entry.inputPath.toLowerCase()));
    js.entries.forEach((entry) => {
        entry.inputPaths.forEach((inputPath) => inputs.add(inputPath.toLowerCase()));
    });

    /** @type {Set<string>} */
    const outputs = new Set();

    for (const [label, block] of [
        ["CSS", css],
        ["JS", js],
    ]) {
        block.entries.forEach((entry) => {
            const key = entry.outputPath.toLowerCase();

            // Drop the `assets/` display prefix to suggest a path the config
            // can use as written.
            const short = entry.output.replace(/^assets\//, "");
            const hint = short.includes("/")
                ? "Rename it, or move it to another folder."
                : `Rename it, or move it into a folder: "built/${short}".`;

            if (inputs.has(key)) {
                throw new EktoKitError(`${label} output "${short}" is also an input`, { hint });
            }

            if (outputs.has(key)) {
                throw new EktoKitError(`${label} output "${short}" is already declared`, { hint });
            }

            outputs.add(key);
        });
    }
}

/**
 * Validates the raw config and returns it normalized: paths resolved to
 * absolute, defaults filled in, and every value checked.
 *
 * Unknown keys are ignored; only what the build depends on is validated.
 *
 * @param {any} config the object the config file default-exported
 * @param {{ root: string }} context
 */
export function validateConfig(config, { root }) {
    const assets = config.assets;

    if (assets !== undefined && (assets === null || typeof assets !== "object" || Array.isArray(assets))) {
        throw new EktoKitError("assets must be an object");
    }

    // `assets` is taken apart here and never travels further: builders and
    // watcher read `config.css` and `config.js` directly.
    const { css: cssRaw, js: jsRaw } = assets ?? {};

    const css = normalizeCss(cssRaw, root, "assets.css");
    const js = normalizeJs(jsRaw, root, "assets.js");

    assertNoOutputConflicts(css, js);

    return {
        root,
        server: normalizeServer(config.server, "server"),
        css,
        js,
        zip: normalizeZip(config.zip, root),
    };
}

/**
 * @typedef {ReturnType<typeof validateConfig>} EktoKitConfig
 */
