/**
 * Error type for every expected failure — anything a user can cause: a bad
 * config, a missing file, a busy port. The CLI renders these as a readable
 * message instead of a stack trace.
 *
 * `detail` carries specifics (a path, a received value) and `hint` says what to
 * do about it; both are optional and both are plain text.
 *
 * @example
 * import { EktoKitError } from "@w3ify/ektokit";
 *
 * throw new EktoKitError("Port 3000 is already in use", {
 *     hint: "Change server.port in ektokit.config.mjs.",
 * });
 */
export class EktoKitError extends Error {
    /**
     * @param {string} message
     * @param {{ detail?: string, hint?: string, cause?: unknown }} [options]
     */
    constructor(message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);

        this.name = "EktoKitError";
        this.detail = options.detail;
        this.hint = options.hint;
    }
}

/**
 * Narrows an unknown error to {@link EktoKitError}, for telling an expected
 * failure from a bug.
 *
 * @example
 * import { isEktoKitError } from "@w3ify/ektokit";
 *
 * function reportError(error) {
 *     if (!isEktoKitError(error)) throw error;
 *     console.error(error.message);
 * }
 *
 * @param {unknown} error
 * @returns {error is EktoKitError}
 */
export function isEktoKitError(error) {
    return error instanceof EktoKitError;
}
