import path from "node:path";

import { createContext, runTasks } from "../context.js";
import { createZip } from "../archive/zip.js";

/**
 * `ektokit zip` — production build, then the theme archive. A failing build
 * prevents archive creation or replacement. Assets already built are kept.
 *
 * @param {{ root: string, logger: import("../logger/logger.js").Logger, version: string }} options
 */
export async function zip({ root, logger, version }) {
    logger.banner(version);

    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["css", "js"]);

    const result = await createZip(ctx);

    logger.task("ZIP", result.name, result.ms);
    logger.write();
    logger.summary(`${result.files.length} files → ${path.relative(root, result.path).split(path.sep).join("/")}`);
    logger.write();

    return result;
}
