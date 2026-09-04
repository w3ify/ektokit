import http from "node:http";
import https from "node:https";

import { CONFIG_FILENAME, CONFIG_PATH } from "../config.js";
import { EktoKitError } from "../errors.js";
import { createReloadHub, injectClient } from "./reload.js";
import { localNetworkAddress } from "./network.js";

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function isHtml(headers) {
    const type = headers["content-type"];
    return typeof type === "string" && type.includes("text/html");
}

/**
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function isEncoded(headers) {
    const encoding = headers["content-encoding"];
    return typeof encoding === "string" && encoding !== "" && encoding !== "identity";
}

/**
 * A `host:port` safe to echo back into a page. The value is client-controlled,
 * so anything that is not a plain hostname or IP with an optional port is
 * refused rather than written into HTML.
 */
const SAFE_HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

const STATUS_STYLES = `
:root {
    color-scheme: dark;
    --zinc-50: #fafafa;
    --zinc-100: #f4f4f5;
    --zinc-200: #e4e4e7;
    --zinc-300: #d4d4d8;
    --zinc-400: #a1a1aa;
    --zinc-500: #71717a;
    --zinc-600: #52525b;
    --zinc-700: #3f3f46;
    --zinc-800: #27272a;
    --zinc-900: #18181b;
    --zinc-950: #09090b;
    --yellow-500: #eab308;
    --red-500: #ef4444;
    --green-500: #22c55e;
    --font-sans: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    --text-xs: 0.75rem;
    --text-xs--line-height: calc(1 / 0.75);
    --text-sm: 0.875rem;
    --text-sm--line-height: calc(1.25 / 0.875);
    --text-base: 1rem;
    --text-base--line-height: 1.5;
    --text-2xl: 1.5rem;
    --text-2xl--line-height: calc(2 / 1.5);
    --text-3xl: 1.875rem;
    --text-3xl--line-height: calc(2.25 / 1.875);
    --text-4xl: 2.25rem;
    --text-4xl--line-height: calc(2.5 / 2.25);
    --tracking-tight: -0.025em;
    --tracking-wide: 0.025em;
    --tracking-wider: 0.05em;
    --spacing: 0.25rem;
    --page: var(--zinc-950);
    --panel: var(--zinc-900);
    --text: var(--zinc-100);
    --muted: var(--zinc-400);
    --line: var(--zinc-700);
    --soft: var(--zinc-800);
    --accent: var(--green-500);
    --warning: var(--yellow-500);
    --radius: calc(var(--spacing) * 2);
    --shadow: 0 calc(var(--spacing) * 2) calc(var(--spacing) * 6) rgba(9, 9, 11, 0.2);
}

* { box-sizing: border-box; }

body {
    min-height: 100vh;
    min-height: 100svh;
    margin: 0;
    padding: calc(var(--spacing) * 5);
    display: grid;
    place-items: center;
    background: var(--page);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
}

main { width: min(100%, calc(var(--spacing) * 160)); }

.panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    box-shadow: var(--shadow);
}

.panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--spacing) * 4);
    padding: calc(var(--spacing) * 3) calc(var(--spacing) * 5);
    border-bottom: 1px solid var(--line);
}

.brand {
    padding: calc(var(--spacing) * 1) calc(var(--spacing) * 2);
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--zinc-950);
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
    font-weight: 700;
    letter-spacing: var(--tracking-wide);
}

.version {
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
    font-weight: 500;
    letter-spacing: var(--tracking-wide);
}

.status-code {
    margin: 0;
    color: var(--warning);
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
    font-weight: 600;
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
}

.content {
    --content-padding: calc(var(--spacing) * 5);
    padding: var(--content-padding);
}

h1 {
    margin: 0;
    margin-top: calc(var(--spacing) * 2);
    font-size: var(--text-2xl);
    line-height: var(--text-2xl--line-height);
    letter-spacing: var(--tracking-tight);
}

.lead {
    max-width: calc(var(--spacing) * 136);
    margin: 0;
    margin-top: calc(var(--spacing) * 3);
    color: var(--muted);
}

code {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
}

.target, .retry { margin-top: calc(var(--spacing) * 5); }

.target {
    display: block;
    overflow-wrap: anywhere;
    padding: calc(var(--spacing) * 3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--page);
    color: var(--text);
}

.checks {
    margin-top: var(--content-padding);
}

.checks h2 {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--text-base--line-height);
}

.checks ol {
    margin: 0;
    margin-top: calc(var(--spacing) * 3);
    padding-left: calc(var(--spacing) * 5);
    color: var(--muted);
}

.checks p {
    margin: 0;
    margin-top: calc(var(--spacing) * 3);
    color: var(--muted);
}

.checks li + li { margin-top: calc(var(--spacing) * 1); }
.checks code { color: var(--text); }

.retry {
    display: flex;
    align-items: center;
    gap: calc(var(--spacing) * 3);
    padding: calc(var(--spacing) * 3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: 600;
}

.retry--warning {
    background: var(--soft);
    color: var(--warning);
}

.retry-dot {
    position: relative;
    width: calc(var(--spacing) * 2);
    height: calc(var(--spacing) * 2);
    flex: 0 0 auto;
    border-radius: 50%;
    color: var(--warning);
    background: currentColor;
}

.retry-dot::after {
    content: "";
    position: absolute;
    inset: calc(var(--spacing) * -1);
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    animation: retry-pulse 1.8s ease-out infinite;
}

@keyframes retry-pulse {
    0% { transform: scale(0.45); opacity: 0.34; }
    70%, 100% { transform: scale(1.45); opacity: 0; }
}

/* Viewport breakpoints stay independent of the component's spacing unit. */
@media (min-width: 40rem) {
    body { padding: calc(var(--spacing) * 8); }
    .content { --content-padding: calc(var(--spacing) * 8); }
    h1 {
        font-size: var(--text-3xl);
        line-height: var(--text-3xl--line-height);
    }
}

@media (min-width: 48rem) {
    body { padding: calc(var(--spacing) * 12); }
    h1 {
        font-size: var(--text-4xl);
        line-height: var(--text-4xl--line-height);
    }
}

@media (min-width: 64rem) {
    body { padding: calc(var(--spacing) * 16); }
}

@media (prefers-reduced-motion: reduce) {
    .retry-dot::after { animation: none; opacity: 0.18; }
}
`;

/**
 * @param {string} value
 */
function escapeHtml(value) {
    const entities = /** @type {Record<string, string>} */ ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    });
    return value.replace(/[&<>"']/g, (character) => entities[character]);
}

/**
 * @param {string} origin the configured Ghost address
 * @param {string} version
 * @param {502 | 503} status
 */
function ghostStatusPage(origin, version, status) {
    const safeOrigin = escapeHtml(origin);
    const safeVersion = escapeHtml(version);
    const waiting = status === 503;
    const statusLabel = waiting ? "503 · Service Unavailable" : "502 · Bad Gateway";
    const title = waiting ? "Ghost is not ready" : "Ghost did not answer";
    const lead = waiting
        ? "Ghost responded, but the site is not available yet:"
        : "The development server is running. Ghost is expected at:";
    const guidance = waiting
        ? `<section class="checks" aria-labelledby="checks-title">
                    <h2 id="checks-title">What to do</h2>
                    <p>If Ghost is starting, wait a moment. If this persists, check its logs.</p>
                </section>`
        : `<section class="checks" aria-labelledby="checks-title">
                    <h2 id="checks-title">What to check</h2>
                    <ol>
                        <li>Ghost is running.</li>
                        <li><code>server.proxy</code> points to this address in <code>${CONFIG_FILENAME}</code>.</li>
                    </ol>
                </section>`;
    const retryMessage = waiting ? "Waiting for Ghost to be ready…" : "Trying to reconnect…";

    return injectClient(`<!DOCTYPE html>
<html lang="en" data-ektokit-proxy-status="${status}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>${title} · EktoKit</title>
    <style>${STATUS_STYLES}</style>
</head>
<body>
    <main>
        <article class="panel">
            <header class="panel-header">
                <span class="brand">EktoKit</span>
                <span class="version">v${safeVersion}</span>
            </header>
            <div class="content">
                <p class="status-code">${statusLabel}</p>
                <h1>${title}</h1>
                <p class="lead">${lead}</p>
                <code class="target">${safeOrigin}</code>

                ${guidance}

                <div class="retry retry--warning" role="status" aria-live="polite">
                    <span class="retry-dot" aria-hidden="true"></span>
                    <span>${retryMessage}</span>
                </div>
            </div>
        </article>
    </main>
</body>
</html>`);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} origin
 * @param {string} version
 * @param {502 | 503} status
 */
function sendGhostStatusPage(req, res, origin, version, status) {
    const body = ghostStatusPage(origin, version, status);

    res.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
    });
    res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * The origin the *client* used, which is the only one its browser can resolve.
 *
 * When the server is exposed to the network two are live at once —
 * `localhost:3000` on the desktop, `192.168.x.x:3000` on a phone — so each
 * response is rewritten for whoever asked for it.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} port fallback when the request carries no usable Host
 * @returns {string}
 */
function requestOrigin(req, port) {
    const host = req.headers.host;

    return typeof host === "string" && SAFE_HOST.test(host)
        ? `http://${host}`
        : `http://localhost:${port}`;
}

/**
 * Replaces every absolute reference to Ghost with the origin the client is on.
 *
 * Two spellings are covered: the plain one used by `href`, `src` and `srcset`,
 * and the escaped one Ghost emits inside its JSON-LD block
 * (`http:\/\/localhost:2368`).
 *
 * @param {string} body
 * @param {string} from Ghost's origin, from `server.proxy`
 * @param {string} to the client's origin
 */
function rewriteOrigin(body, from, to) {
    if (from === to) return body;

    const escape = (/** @type {string} */ value) => value.split("/").join("\\/");

    return body.split(escape(from)).join(escape(to)).split(from).join(to);
}

/**
 * Development server: proxies Ghost, injects the live-reload client into HTML
 * responses, and exposes a `reload()` for the watcher to call.
 *
 * Non-HTML responses stream through untouched.
 *
 * @param {import("../context.js").Context} ctx
 * @param {{ exposed?: boolean, version?: string }} [options] network binding and displayed version
 */
export function createDevServer(ctx, { exposed = ctx.config.server.host, version = "" } = {}) {
    const target = ctx.config.server.proxyUrl;
    const transport = target.protocol === "https:" ? https : http;

    /**
     * Performs one direct availability check against Ghost. Any HTTP response
     * means the target is reachable; only Ghost's maintenance 503 is a distinct
     * state in the current scope.
     *
     * @param {number} timeoutMs
     * @param {AbortSignal} [signal]
     * @returns {Promise<{
     *   status: "ready" | "502" | "503",
     *   reason: string | null,
     * }>}
     */
    function checkTarget(timeoutMs, signal) {
        return new Promise((resolve) => {
            let settled = false;

            /**
             * @param {"ready" | "502" | "503"} status
             * @param {string | null} reason
             */
            const finish = (status, reason) => {
                if (settled) return;
                settled = true;
                resolve({ status, reason });
            };

            const check = transport.request(
                {
                    protocol: target.protocol,
                    hostname: target.hostname,
                    port: target.port || (target.protocol === "https:" ? 443 : 80),
                    method: "HEAD",
                    path: "/",
                    timeout: timeoutMs,
                    headers: { host: target.host },
                    signal,
                },
                (response) => {
                    response.resume();
                    check.setTimeout(0);
                    finish(response.statusCode === 503 ? "503" : "ready", null);
                },
            );

            check.on("timeout", () => {
                check.destroy();
                finish("502", `no response within ${timeoutMs}ms`);
            });

            check.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
                finish("502", error.code ?? error.message);
            });

            check.end();
        });
    }

    const hub = createReloadHub({
        probe: async (signal) => (await checkTarget(2000, signal)).status,
    });

    /**
     * @param {import("node:http").IncomingMessage} req
     */
    function requestOptions(req) {
        const headers = { ...req.headers };

        // Injection needs readable HTML, and identity keeps the hop cheap.
        headers["accept-encoding"] = "identity";
        headers.host = target.host;

        return {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === "https:" ? 443 : 80),
            method: req.method,
            path: req.url,
            headers,
        };
    }

    /**
     * Keeps the browser inside the EktoKit origin when Ghost redirects to itself.
     *
     * @param {string | string[] | undefined} location
     * @param {string} origin
     */
    function rewriteLocation(location, origin) {
        if (typeof location !== "string") return location;

        const targetOrigin = target.origin;

        return location.startsWith(targetOrigin)
            ? `${origin}${location.slice(targetOrigin.length)}`
            : location;
    }

    const server = http.createServer((req, res) => {
        if (hub.handle(req, res)) return;

        const proxyReq = transport.request(requestOptions(req), (proxyRes) => {
            const headers = { ...proxyRes.headers };
            const origin = requestOrigin(req, ctx.config.server.port);
            const status = proxyRes.statusCode ?? 502;

            // Ghost admin is a single-page app that builds its own API calls,
            // and its pages hold work that is not saved yet. It is passed
            // through exactly as Ghost served it: neither rewritten nor given
            // the reload client, so saving a theme file never reloads it.
            const isAdmin = (req.url ?? "").startsWith("/ghost/");

            if (!isAdmin && status === 503 && isHtml(proxyRes.headers)) {
                proxyRes.resume();
                sendGhostStatusPage(req, res, target.origin, version, 503);
                return;
            }

            if (headers.location) {
                headers.location = rewriteLocation(headers.location, origin);
            }

            if (!isHtml(proxyRes.headers) || isEncoded(proxyRes.headers)) {
                res.writeHead(proxyRes.statusCode ?? 502, headers);
                proxyRes.pipe(res);
                return;
            }

            /** @type {Buffer[]} */
            const chunks = [];

            proxyRes.on("data", (chunk) => chunks.push(chunk));
            proxyRes.on("end", () => {
                const html = Buffer.concat(chunks).toString("utf8");
                const body = isAdmin
                    ? html
                    : injectClient(rewriteOrigin(html, target.origin, origin));

                // The body was buffered to inject the client, so the response
                // is no longer chunked and its length changed.
                delete headers["transfer-encoding"];
                headers["content-length"] = String(Buffer.byteLength(body));

                res.writeHead(proxyRes.statusCode ?? 502, headers);
                res.end(body);
            });
        });

        proxyReq.on("error", () => {
            if (res.headersSent) {
                res.destroy();
                return;
            }

            sendGhostStatusPage(req, res, target.origin, version, 502);
        });

        req.pipe(proxyReq);
    });

    // Ghost's admin uses upgraded connections; pass them straight through.
    server.on("upgrade", (req, socket, head) => {
        const proxyReq = transport.request(requestOptions(req));

        proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
            const lines = Object.entries(proxyRes.headers).flatMap(([key, value]) =>
                Array.isArray(value) ? value.map((item) => `${key}: ${item}`) : [`${key}: ${value}`],
            );

            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);

            if (proxyHead.length > 0) proxySocket.unshift(proxyHead);

            proxySocket.on("error", () => socket.destroy());
            socket.on("error", () => proxySocket.destroy());

            proxySocket.pipe(socket).pipe(proxySocket);
        });

        proxyReq.on("error", () => socket.destroy());

        if (head.length > 0) req.unshift(head);

        req.pipe(proxyReq);
    });

    return {
        reload: () => hub.reload(),

        /**
         * Asks the proxy target for a response, once, so the CLI can report an
         * unreachable Ghost at startup.
         *
         * Never throws and never blocks development: building CSS and
         * JavaScript does not need Ghost running.
         *
         * @param {number} [timeoutMs]
         * @returns {Promise<string | null>} the reason it failed, or null
         */
        async probe(timeoutMs = 2000) {
            const result = await checkTarget(timeoutMs);
            return result.status === "502" ? result.reason : null;
        },

        /**
         * @param {number} [port]
         */
        async start(port = ctx.config.server.port) {
            const bindAddress = exposed ? "0.0.0.0" : "127.0.0.1";

            await new Promise((resolve, reject) => {
                const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
                    reject(
                        error.code === "EADDRINUSE"
                            ? new EktoKitError(`Port ${port} is already in use`, {
                                  hint: `Change server.port in ${CONFIG_PATH} or stop the process using it.`,
                                  cause: error,
                              })
                            : error,
                    );
                };

                server.once("error", onError);
                server.listen(port, bindAddress, () => {
                    server.off("error", onError);
                    resolve(undefined);
                });
            });

            const address = server.address();
            const boundPort = typeof address === "object" && address ? address.port : port;

            return {
                port: boundPort,
                local: `http://localhost:${boundPort}`,
                network: exposed ? networkUrl(boundPort) : null,
                proxy: target.origin,
            };
        },

        async close() {
            hub.close();

            await new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve(undefined));
            });
        },
    };
}

/**
 * @param {number} port
 */
function networkUrl(port) {
    const address = localNetworkAddress();
    return address ? `http://${address}:${port}` : null;
}
