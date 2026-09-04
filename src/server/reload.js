import { randomUUID } from "node:crypto";

export const RELOAD_BASE = "/__ektokit";
export const RELOAD_STREAM = `${RELOAD_BASE}/live`;
export const RELOAD_CLIENT = `${RELOAD_BASE}/client.js`;

const SNIPPET = `<script src="${RELOAD_CLIENT}" defer></script>`;
const STATUS_CHECK_MS = 2000;
const STATUS_FAILURE_THRESHOLD = 2;

/**
 * The client injected into every HTML response.
 *
 * Server-Sent Events give a persistent, auto-reconnecting connection out of
 * built-in browser and Node APIs, so live reload costs no dependency. Reload
 * and proxy status are both one-way, which is exactly the shape of the problem.
 */
const CLIENT_SOURCE = `(() => {
    let instance = null;
    let navigating = false;

    const currentStatus = document.documentElement.dataset.ektokitProxyStatus || "ready";

    const reload = () => {
        if (navigating) return;
        navigating = true;
        window.location.reload();
    };

    const connect = () => {
        const source = new EventSource("${RELOAD_STREAM}");

        source.addEventListener("hello", (event) => {
            if (instance !== null && instance !== event.data) {
                reload();
                return;
            }

            instance = event.data;
        });

        source.addEventListener("proxy-status", (event) => {
            if (event.data !== currentStatus) reload();
        });

        source.addEventListener("reload", reload);
    };

    if (typeof EventSource === "function") connect();
})();
`;

/**
 * Injects the reload client into an HTML document.
 *
 * @param {string} html
 */
export function injectClient(html) {
    if (html.includes(RELOAD_CLIENT)) return html;

    const closingBody = html.lastIndexOf("</body>");

    if (closingBody !== -1) {
        return `${html.slice(0, closingBody)}    ${SNIPPET}\n${html.slice(closingBody)}`;
    }

    const closingHead = html.lastIndexOf("</head>");

    if (closingHead !== -1) {
        return `${html.slice(0, closingHead)}    ${SNIPPET}\n${html.slice(closingHead)}`;
    }

    return `${html}\n${SNIPPET}\n`;
}

/**
 * Keeps track of connected browsers, broadcasts reload events and runs one
 * shared proxy-status probe while at least one browser is listening.
 *
 * @param {{
 *   probe?: (signal: AbortSignal) => Promise<"ready" | "502" | "503">,
 *   intervalMs?: number,
 *   failureThreshold?: number,
 * }} [options]
 */
export function createReloadHub({
    probe,
    intervalMs = STATUS_CHECK_MS,
    failureThreshold = STATUS_FAILURE_THRESHOLD,
} = {}) {
    /** @type {Set<import("node:http").ServerResponse>} */
    const clients = new Set();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let checkTimer = null;
    /** @type {AbortController | null} */
    let checkController = null;
    /** @type {"ready" | "502" | "503" | null} */
    let proxyStatus = null;
    let consecutiveFailures = 0;
    let monitorGeneration = 0;
    let monitoring = false;

    // Identifies this run of the server, so a client can tell a restart from a
    // dropped stream.
    const instance = randomUUID();

    // Comment frames keep proxies and browsers from dropping an idle stream.
    const heartbeat = setInterval(() => {
        for (const client of clients) client.write(": ping\n\n");
    }, 20_000);

    heartbeat.unref();

    /**
     * @param {string} event
     * @param {string} data
     */
    function broadcast(event, data) {
        for (const client of clients) client.write(`event: ${event}\ndata: ${data}\n\n`);
    }

    /** @param {"ready" | "502" | "503"} status */
    function publishStatus(status) {
        if (status === proxyStatus) return;

        proxyStatus = status;
        broadcast("proxy-status", status);
    }

    /** @param {number} generation */
    function scheduleCheck(generation) {
        if (!monitoring || generation !== monitorGeneration) return;

        checkTimer = setTimeout(() => void checkProxy(generation), intervalMs);
        checkTimer.unref?.();
    }

    /** @param {number} generation */
    async function checkProxy(generation) {
        if (!probe || !monitoring || generation !== monitorGeneration) return;

        const controller = new AbortController();
        checkController = controller;

        /** @type {"ready" | "502" | "503" | null} */
        let nextStatus = null;

        try {
            nextStatus = await probe(controller.signal);
        } catch {
            if (!controller.signal.aborted) nextStatus = "502";
        } finally {
            if (checkController === controller) checkController = null;
        }

        if (!monitoring || generation !== monitorGeneration || nextStatus === null) return;

        if (nextStatus === "502") {
            consecutiveFailures += 1;

            if (consecutiveFailures < failureThreshold) {
                scheduleCheck(generation);
                return;
            }
        } else {
            consecutiveFailures = 0;
        }

        publishStatus(nextStatus);
        scheduleCheck(generation);
    }

    function startMonitor() {
        if (!probe || monitoring) return;

        monitoring = true;
        monitorGeneration += 1;
        void checkProxy(monitorGeneration);
    }

    function stopMonitor() {
        if (!monitoring && proxyStatus === null) return;

        monitoring = false;
        monitorGeneration += 1;
        consecutiveFailures = 0;
        proxyStatus = null;

        if (checkTimer !== null) clearTimeout(checkTimer);
        checkTimer = null;

        checkController?.abort();
        checkController = null;
    }

    return {
        get size() {
            return clients.size;
        },

        /**
         * @param {import("node:http").IncomingMessage} req
         * @param {import("node:http").ServerResponse} res
         */
        handle(req, res) {
            if (req.url === RELOAD_CLIENT) {
                res.writeHead(200, {
                    "content-type": "application/javascript; charset=utf-8",
                    "cache-control": "no-store",
                });
                res.end(CLIENT_SOURCE);
                return true;
            }

            if (req.url === RELOAD_STREAM) {
                res.writeHead(200, {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-store",
                    connection: "keep-alive",
                });
                res.write("retry: 1000\n\n");
                res.write(`event: hello\ndata: ${instance}\n\n`);

                clients.add(res);

                if (proxyStatus !== null) {
                    res.write(`event: proxy-status\ndata: ${proxyStatus}\n\n`);
                }

                if (clients.size === 1) startMonitor();

                req.on("close", () => {
                    if (!clients.delete(res)) return;
                    if (clients.size === 0) stopMonitor();
                });

                return true;
            }

            return false;
        },

        reload() {
            broadcast("reload", "{}");
        },

        close() {
            clearInterval(heartbeat);
            stopMonitor();

            for (const client of clients) client.end();

            clients.clear();
        },
    };
}
