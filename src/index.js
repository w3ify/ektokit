/**
 * Development tool for Ghost themes with CSS and JavaScript builds, live reload,
 * and ZIP packaging.
 *
 * The supported way to use this package is the `ektokit` binary and the
 * `ektokit.config.mjs` file it reads; see the README for both. The exports below
 * exist for embedding the CLI in a script and for handling its errors by type —
 * everything else is internal.
 *
 * @packageDocumentation
 */

export { run } from "./cli.js";
export { EktoKitError, isEktoKitError } from "./errors.js";
