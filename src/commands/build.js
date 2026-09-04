import { createContext, runTasks } from "../context.js";

/**
 * `ektokit build` — production CSS and JavaScript. No server, watcher, reload
 * or archive.
 *
 * @param {{ root: string, logger: import("../logger/logger.js").Logger, version: string }} options
 */
export async function build({ root, logger, version }) {
    logger.banner(version);

    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["css", "js"]);

    logger.write();

    return ctx;
}
