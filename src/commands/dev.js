import { CONFIG_PATH } from "../config.js";
import { createContext, runTasksIsolated } from "../context.js";
import { createDevServer } from "../server/proxy.js";
import { createWatcher } from "../watcher/watcher.js";

/**
 * `ektokit dev` — initial build, Ghost proxy, live reload and watcher.
 *
 * Asset build errors are reported without stopping the watcher. A later
 * relevant save can rebuild the affected entries. Configuration and server
 * startup errors still prevent the session from starting.
 *
 * @param {{
 *   root: string,
 *   logger: import("../logger/logger.js").Logger,
 *   version: string,
 *   host?: boolean,
 * }} options
 */
export async function dev({ root, logger, version, host }) {
    logger.banner(version);

    const ctx = await createContext({ root, mode: "development", logger });

    // Use the watcher's runner so asset failures do not prevent other entries
    // from building or stop the session from watching for corrections.
    const { failed } = await runTasksIsolated(ctx, ["css", "js"], { announceEmpty: true });

    const exposed = host ?? ctx.config.server.host;
    const server = createDevServer(ctx, { exposed, version });

    const urls = await server.start();

    const watcher = createWatcher(ctx, { onReload: () => {
        logger.reload();
        server.reload();
    } });

    await watcher.start();

    // Spacing belongs to the caller, and an error block already closes with a
    // blank line — so the separator before the addresses is only needed when
    // the build ended on a task line.
    if (!failed) logger.write();

    // Origin first, then where to open it: Ghost → EktoKit → the LAN.
    logger.url("Proxy", urls.proxy);
    logger.url("Local", urls.local);

    // The row is always printed, so the absence of a LAN address reads as a
    // state of this run rather than as a feature nobody mentioned. Whoever
    // passed --host came here for the address, so its absence is already the
    // signal: the row says why in the same muted tone as the hint above it.
    if (urls.network) logger.url("Network", urls.network);
    else if (exposed) logger.info("Network", "unable to find network to expose");
    else logger.info("Network", "use --host to expose");

    // Otherwise the only sign of an unreachable Ghost is the 502 page, which
    // needs a browser to be seen. Never fatal: builds do not depend on Ghost.
    const unreachable = await server.probe();

    if (unreachable) {
        logger.write();
        logger.warn(`Ghost did not answer at ${urls.proxy} (${unreachable})`);
        logger.note(`Start Ghost, or fix server.proxy in ${CONFIG_PATH}.`);
    }

    logger.write();
    logger.watching();

    // Watch events are timestamped so their order stays readable.
    logger.setTimestamps(true);

    const stop = async () => {
        logger.setTimestamps(false);
        await watcher.close();
        await server.close();
    };

    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            void stop().then(() => {
                logger.write();
                process.exit(0);
            });
        });
    }

    return { ctx, server, watcher, urls, stop };
}
