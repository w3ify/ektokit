import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Logger } from "./logger/logger.js";
import { EktoKitError } from "./errors.js";
import { build } from "./commands/build.js";
import { dev } from "./commands/dev.js";
import { zip } from "./commands/zip.js";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * Where `--help` sends anyone who needs more than one screen of it.
 */
const PROJECT_URL = "https://github.com/w3ify/ektokit";

/**
 * One description column for both blocks, wide enough for `-v, --version`,
 * which is the longest thing on the left.
 */
const USAGE = `Usage: ektokit <command> [options]

Commands:
  dev            Build, serve Ghost through the proxy, and watch for changes
  build          Production build (CSS + JS)
  zip            Production build followed by the theme ZIP

Options:
  --host         dev only: also expose the server on the local network
  -v, --version  Print the version
  -h, --help     Print this message

For more information, see the README at ${PROJECT_URL}
`;

/**
 * The flag only ever turns network exposure on. To keep it off, remove it —
 * `server.host` in the config is the default.
 *
 * @param {Set<string>} flags
 * @returns {true | undefined} undefined means: leave it to the config
 */
export function wantsHost(flags) {
    return flags.has("--host") ? true : undefined;
}

async function readVersion() {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    return JSON.parse(raw).version;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const flags = new Set(argv.filter((arg) => arg.startsWith("-")));
    const command = argv.find((arg) => !arg.startsWith("-"));

    return { command, flags };
}

/**
 * Runs the CLI: parses the arguments, executes the command from the current
 * working directory, and reports failures the same way the binary does.
 *
 * Command failures set `process.exitCode = 1` rather than being rethrown.
 * Does not return build results or a server handle.
 *
 * @example
 * import { run } from "@w3ify/ektokit";
 *
 * await run(["build"]);
 *
 * @param {string[]} argv arguments after the binary name, e.g. `["dev", "--host"]`
 */
export async function run(argv) {
    const logger = new Logger();
    const version = await readVersion();
    const { command, flags } = parseArgs(argv);

    if (flags.has("-v") || flags.has("--version")) {
        logger.write(version);
        return;
    }

    const wantsHelp = flags.has("-h") || flags.has("--help");

    if (!command || wantsHelp) {
        logger.write(USAGE);

        // No command at all is a usage error; asking for help is not.
        if (!command && !wantsHelp) process.exitCode = 1;

        return;
    }

    const root = process.cwd();

    try {
        switch (command) {
            case "build": {
                await build({ root, logger, version });
                break;
            }

            case "dev": {
                await dev({
                    root,
                    logger,
                    version,
                    // The flag only ever turns exposure on.
                    host: wantsHost(flags),
                });
                break;
            }

            case "zip": {
                await zip({ root, logger, version });
                break;
            }

            default: {
                throw new EktoKitError(`Unknown command: ${command}`, {
                    hint: "Run ektokit --help to see the commands.",
                });
            }
        }
    } catch (error) {
        logger.failure(`${command} failed`, error);
        process.exitCode = 1;
    }
}
