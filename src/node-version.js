/**
 * The runtime floor, checked before anything else loads.
 *
 * Keep this module dependency-free and parseable on older Node versions so
 * the binary can report the supported minimum without loading the tool.
 */
export const MINIMUM_NODE_MAJOR = 22;

/**
 * @param {string} version a `process.versions.node` string, like `"20.11.1"`
 * @returns {boolean} false when the CLI refuses to run
 */
export function isSupportedNode(version) {
    const major = Number.parseInt(String(version).split(".")[0], 10);

    return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

/**
 * @param {string} version
 * @returns {string} what the binary prints before exiting
 */
export function unsupportedNodeMessage(version) {
    return [
        `EktoKit needs Node.js ${MINIMUM_NODE_MAJOR} or newer — this is v${version}.`,
        "",
        `Ghost 6 needs Node.js ${MINIMUM_NODE_MAJOR} as well, so one install covers both.`,
        "Download: https://nodejs.org",
        "",
    ].join("\n");
}
