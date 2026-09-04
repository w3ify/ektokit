/**
 * Configuration for the EktoKit CLI, exported as the default from
 * `ektokit.config.mjs` in the theme root.
 *
 * Annotating the config gives completion and hover in the editor. Add
 * `// @ts-check` on the first line to also get errors underlined:
 *
 * ```js
 * // @ts-check
 *
 * /** @type {import("@w3ify/ektokit").EktoKitConfig} *\/
 * export default {
 *     assets: {
 *         css: { processor: "tailwind", entries: [] },
 *     },
 * };
 * ```
 *
 * Every top-level key is optional and has a default.
 */
export interface EktoKitConfig {
    /** Development server and Ghost proxy. */
    server?: ServerConfig;

    /** What to build out of the theme's `assets/` directory. */
    assets?: AssetsConfig;

    /** The archive `ektokit zip` writes. */
    zip?: ZipConfig;
}

/**
 * What gets built out of the theme's `assets/` directory.
 *
 * Every `input` and `output` below is relative to `assets/`, so the prefix is
 * never written — the same shape Ghost's own `{{asset "built/style.css"}}`
 * helper uses.
 */
export interface AssetsConfig {
    /** Stylesheets, and the processor that builds them. */
    css?: CssConfig;

    /** JavaScript bundles. */
    js?: JsConfig;
}

/** Development server and Ghost proxy. */
export interface ServerConfig {
    /**
     * URL of the Ghost instance to proxy. Use the same value as `url` in
     * Ghost's `config.development.json`.
     *
     * @default "http://localhost:2368"
     */
    proxy?: string;

    /**
     * Port EktoKit listens on.
     *
     * @default 3000
     */
    port?: number;

    /**
     * Expose the server on the local network. `ektokit dev --host` does the
     * same for a single run.
     *
     * @default false
     */
    host?: boolean;
}

/** Stylesheets, and the processor that builds them. */
export interface CssConfig {
    /**
     * Which processor builds the stylesheets. `"tailwind"` requires
     * `tailwindcss` and `@tailwindcss/postcss` installed in the theme;
     * `"vanilla"` requires nothing.
     *
     * @default "vanilla"
     */
    processor?: "tailwind" | "vanilla";

    /**
     * Stylesheets to build. Each entry is one output file.
     *
     * @default []
     */
    entries?: CssEntry[];
}

/** One stylesheet to build. */
export interface CssEntry {
    /** Stylesheet to build. One existing file, relative to `assets/`. */
    input: string;

    /** Destination directory and filename, relative to `assets/`. */
    output: string;
}

/** JavaScript bundles. */
export interface JsConfig {
    /**
     * Bundles to build. Each entry is one output file.
     *
     * @default []
     */
    entries?: JsEntry[];
}

/** One JavaScript bundle to build. */
export interface JsEntry {
    /**
     * Existing files to bundle, relative to `assets/`. Use a string for one
     * source or an array for multiple sources in the order written.
     * Syntax is checked in development and production; production also
     * minifies the bundle.
     *
     * Packages from `node_modules` are not supported. Copy the vendor file in
     * with the theme's own scripts — `js/lib/` is a common spot — and list it
     * like any other input.
     */
    input: string | string[];

    /** Destination directory and filename, relative to `assets/`. */
    output: string;
}

/** The archive `ektokit zip` writes. */
export interface ZipConfig {
    /**
     * Portable archive file name, without a path or the `.zip` extension.
     * Falls back to the `name` in the theme's `package.json`, which must follow
     * the same rules.
     */
    name?: string;

    /**
     * Additional glob patterns to exclude. `dist/`, dependency and Git
     * directories, common system files, and root-level `.npmrc`, `.env` and
     * `.env.*` files are already excluded.
     *
     * @default []
     */
    ignore?: string[];
}

/**
 * Runs the CLI from the current working directory, using `ektokit.config.mjs`.
 * Reports command failures and sets `process.exitCode = 1` instead of
 * rethrowing them. Does not return build results or a server handle.
 *
 * @param argv Arguments after the binary name, e.g. `["dev", "--host"]`.
 * @example
 * import { run } from "@w3ify/ektokit";
 * await run(["build"]);
 */
export function run(argv: string[]): Promise<void>;

/**
 * An expected failure, such as an invalid config, missing file or busy port.
 * The CLI presents these errors without a stack trace.
 */
export class EktoKitError extends Error {
    /**
     * Creates an error with optional plain-text details and recovery guidance.
     *
     * @param message Summary of the failure.
     * @param options Additional context and the underlying cause.
     */
    constructor(message: string, options?: {
        /** Specifics, such as a file path or received value. */
        detail?: string;
        /** Guidance on how to resolve the failure. */
        hint?: string;
        /** The underlying error or value that caused the failure. */
        cause?: unknown;
    });

    /** Specifics, such as a file path or received value, in plain text. */
    detail: string | undefined;
    /** Guidance on how to resolve the failure, in plain text. */
    hint: string | undefined;
}

/**
 * Identifies an EktoKitError and narrows its type to expose `detail` and `hint`.
 *
 * @param error The value to inspect.
 * @returns Whether the value is an instance of EktoKitError.
 */
export function isEktoKitError(error: unknown): error is EktoKitError;
