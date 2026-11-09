import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createContext } from "../src/context.js";
import { createDevServer } from "../src/server/proxy.js";
import {
    createReloadHub,
    injectClient,
    RELOAD_CLIENT,
    RELOAD_STREAM,
} from "../src/server/reload.js";
import { makeLogger, makeProject } from "./helpers.js";

const HTML = `<!DOCTYPE html>
<html><head><title>Ghost</title></head>
<body><h1>Ghost</h1></body></html>`;

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html><head><title>We’ll be right back.</title></head>
<body><h1>We’ll be right back.</h1></body></html>`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

/**
 * Minimal stand-in for a running Ghost instance.
 */
async function fakeGhost() {
    /** @type {Array<{ method: string, url: string, headers: any, body: string }>} */
    const requests = [];
    let status = 200;
    let origin = "";

    const server = http.createServer((req, res) => {
        /** @type {Buffer[]} */
        const chunks = [];

        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            requests.push({
                method: req.method ?? "",
                url: req.url ?? "",
                headers: req.headers,
                body: Buffer.concat(chunks).toString("utf8"),
            });

            if (status === 503) {
                res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
                res.end(req.method === "HEAD" ? undefined : MAINTENANCE_HTML);
                return;
            }

            if (req.url === "/image.png") {
                res.writeHead(200, { "content-type": "image/png" });
                res.end(PNG);
                return;
            }

            if (req.url === "/redirect") {
                res.writeHead(302, { location: `${origin}/target` });
                res.end();
                return;
            }

            // Ghost renders absolute URLs from its own `url` config, so every
            // page it serves points back at its own origin.
            if (req.url === "/absolute" || (req.url ?? "").startsWith("/ghost/")) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(
                    `<!DOCTYPE html><html><head>` +
                        `<link rel="stylesheet" href="${origin}/assets/built/style.css">` +
                        `<link rel="canonical" href="${origin}/post/">` +
                        `<script type="application/ld+json">` +
                        `{"url":"${origin.split("/").join("\\/")}\\/post\\/"}` +
                        `</script>` +
                        `</head><body>` +
                        `<img src="${origin}/content/images/hero.jpg">` +
                        `<a href="${origin}/sobre/">sobre</a>` +
                        `</body></html>`,
                );
                return;
            }

            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(HTML);
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = /** @type {any} */ (server.address());
    origin = `http://127.0.0.1:${port}`;

    return {
        port,
        origin,
        requests,
        setStatus: (nextStatus) => {
            status = nextStatus;
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/**
 * @param {string} url
 * @param {import("node:http").RequestOptions} [options]
 */
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];

            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                }),
            );
        });

        req.on("error", reject);
        req.end(options.body);
    });
}

/**
 * Runs the browser client without a browser so its SSE decisions can be
 * asserted deterministically.
 *
 * @param {string} source
 * @param {{ status?: "ready" | "502" | "503" }} [options]
 */
function reloadClientHarness(source, { status = "ready" } = {}) {
    let reloads = 0;
    const listeners = new Map();
    let streamUrl = null;

    class EventSource {
        constructor(url) {
            streamUrl = url;
        }

        addEventListener(type, listener) {
            listeners.set(type, listener);
        }
    }

    const window = {
        location: {
            href: "http://localhost:3000/post/",
            reload() {
                reloads += 1;
            },
        },
    };

    const document = {
        documentElement: {
            dataset: status === "ready" ? {} : { ektokitProxyStatus: status },
        },
    };

    runInNewContext(source, {
        EventSource,
        document,
        window,
    });

    return {
        get reloads() {
            return reloads;
        },
        get streamUrl() {
            return streamUrl;
        },
        emit(type, data = "") {
            listeners.get(type)?.({ data });
        },
    };
}

/**
 * Connects a minimal in-memory client to a reload hub.
 *
 * @param {ReturnType<typeof createReloadHub>} hub
 */
function reloadHubClient(hub) {
    const req = new EventEmitter();
    const chunks = [];
    let ended = false;

    Object.assign(req, { url: RELOAD_STREAM });

    const res = {
        writeHead() {},
        write(chunk) {
            chunks.push(String(chunk));
            return true;
        },
        end() {
            ended = true;
        },
    };

    assert.equal(hub.handle(/** @type {any} */ (req), /** @type {any} */ (res)), true);

    return {
        close() {
            req.emit("close");
        },
        get ended() {
            return ended;
        },
        get output() {
            return chunks.join("");
        },
    };
}

/**
 * @param {() => boolean} condition
 * @param {number} [timeoutMs]
 */
async function waitFor(condition, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("condition was not met in time");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/**
 * @param {string} proxyOrigin
 */
async function devContext(proxyOrigin) {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            server: { proxy: "${proxyOrigin}", port: 3000, host: false },
            assets: {
                css: { processor: "vanilla", entries: [] },
            },
        };`,
    });

    const { logger } = makeLogger();

    return createContext({ root, mode: "development", logger });
}

/**
 * Opens the reload stream and resolves the instance id it announces.
 *
 * @param {string} url
 */
function readHello(url) {
    let req;
    let timeout;
    return new Promise((resolve, reject) => {
        req = http.get(url, (res) => {
            let buffer = "";

            res.on("data", (chunk) => {
                buffer += chunk.toString("utf8");

                const match = /event: hello\ndata: (.+)\n/.exec(buffer);

                if (match) {
                    req.destroy();
                    resolve(match[1]);
                }
            });
        });

        req.on("error", (error) => {
            if (!/socket hang up|aborted/i.test(error.message)) reject(error);
        });

        timeout = setTimeout(() => reject(new Error("no hello event")), 3000);
    }).finally(() => {
        clearTimeout(timeout);
        req.destroy();
    });
}

test("proxies Ghost and injects the reload client into HTML", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const response = /** @type {any} */ (await request(`${urls.local.replace("localhost", "127.0.0.1")}/`));
    const body = response.body.toString("utf8");

    assert.equal(response.status, 200);
    assert.match(body, /<h1>Ghost<\/h1>/);
    assert.ok(body.includes(RELOAD_CLIENT), "reload client is injected");
    assert.ok(body.indexOf(RELOAD_CLIENT) < body.indexOf("</body>"), "injected before </body>");
    assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(body));
});

test("serves the reload client and streams reload events", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const client = /** @type {any} */ (await request(`${origin}${RELOAD_CLIENT}`));

    assert.equal(client.status, 200);
    assert.match(client.headers["content-type"], /javascript/);
    assert.match(client.body.toString("utf8"), /EventSource/);

    const received = await new Promise((resolve, reject) => {
        let requestedReload = false;
        const req = http.get(`${origin}${RELOAD_STREAM}`, (res) => {
            let buffer = "";

            assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);

            res.on("data", (chunk) => {
                buffer += chunk.toString("utf8");

                if (!requestedReload && buffer.includes("event: proxy-status\ndata: ready")) {
                    requestedReload = true;
                    server.reload();
                }

                if (buffer.includes("event: reload")) {
                    req.destroy();
                    resolve(buffer);
                }
            });
        });

        req.on("error", (error) => {
            if (!/socket hang up|aborted/i.test(error.message)) reject(error);
        });

        const timeout = setTimeout(() => reject(new Error("no reload event")), 3000);
        t.after(() => {
            clearTimeout(timeout);
            req.destroy();
        });
    });

    assert.match(/** @type {string} */ (received), /event: reload/);
    assert.match(/** @type {string} */ (received), /event: proxy-status\ndata: ready/);
    assert.ok(
        ghost.requests.some(({ method, url }) => method === "HEAD" && url === "/"),
        "the server probes Ghost while an SSE client is connected",
    );
});

test("passes binary responses through untouched", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const response = /** @type {any} */ (
        await request(`${urls.local.replace("localhost", "127.0.0.1")}/image.png`)
    );

    assert.equal(response.headers["content-type"], "image/png");
    assert.deepEqual(response.body, PNG);
});

test("forwards the request method and body to Ghost", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    await request(`${urls.local.replace("localhost", "127.0.0.1")}/members/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"email":"a@b.c"}',
    });

    const last = ghost.requests.at(-1);

    assert.equal(last?.method, "POST");
    assert.equal(last?.url, "/members/api");
    assert.equal(last?.body, '{"email":"a@b.c"}');
});

test("rewrites redirects back to the EktoKit origin", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const response = /** @type {any} */ (await request(`${origin}/redirect`));

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, `http://${new URL(origin).host}/target`);
});

test("reports an unreachable Ghost instead of crashing", async (t) => {
    const ghost = await fakeGhost();
    const origin = ghost.origin;
    await ghost.close();

    const ctx = await devContext(origin);
    const server = createDevServer(ctx, { version: "1.0.0" });
    const urls = await server.start(0);
    t.after(() => server.close());

    const response = /** @type {any} */ (
        await request(`${urls.local.replace("localhost", "127.0.0.1")}/`)
    );

    const body = response.body.toString("utf8");

    assert.equal(response.status, 502);
    assert.match(body, /Ghost did not answer/);
    assert.match(body, /The development server is running\. Ghost is expected at:/);
    assert.match(body, /<title>Ghost did not answer · EktoKit<\/title>/);
    assert.match(body, /class="version">v1\.0\.0<\/span>/);
    assert.match(body, /<header class="panel-header">\s*<span class="brand">EktoKit<\/span>\s*<span class="version">v1\.0\.0<\/span>\s*<\/header>/);
    assert.equal((body.match(/class="version"/g) ?? []).length, 1);
    assert.match(body, /<p class="status-code">502 · Bad Gateway<\/p>\s*<h1>/);
    assert.doesNotMatch(body, /eyebrow|brand-lockup|>Ghost proxy</);
    assert.match(body, /502 · Bad Gateway/);
    assert.match(body, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body, /Ghost is running/);
    assert.match(body, /<h2 id="checks-title">What to check<\/h2>/);
    assert.match(body, /server\.proxy/);
    assert.match(body, /ektokit\.config\.mjs/);
    assert.match(body, /Trying to reconnect…/);
    assert.match(body, /retry retry--warning/, "an unavailable preview is a warning, not a build failure");
    assert.doesNotMatch(body, /retry--error|gradient\(/);
    for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        assert.ok(body.includes(`--zinc-${shade}:`), "the full Zinc palette is available");
    }
    assert.match(body, /--yellow-500: #eab308/);
    assert.match(body, /--red-500: #ef4444/);
    assert.match(body, /--green-500: #22c55e/);
    assert.match(body, /--radius: calc\(var\(--spacing\) \* 2\);/);
    assert.equal((body.match(/border-radius: var\(--radius\);/g) ?? []).length, 4,
        "the panel, brand, address and retry share one radius");
    assert.match(body, /\.retry-dot\s*\{[^}]*border-radius: 50%;/);
    assert.match(body, /font-family: var\(--font-sans\)/);
    assert.match(body, /font-family: var\(--font-mono\)/);
    const typeScale = { xs: "0.75rem", sm: "0.875rem", base: "1rem", "2xl": "1.5rem", "3xl": "1.875rem", "4xl": "2.25rem" };
    for (const [name, size] of Object.entries(typeScale)) {
        assert.ok(body.includes(`--text-${name}: ${size};`));
    }
    for (const [, size] of body.matchAll(/font-size:\s*([^;]+);/g)) {
        assert.match(size, /^var\(--text-(xs|sm|base|2xl|3xl|4xl)\)$/,
            "every font size uses the standard type scale, including the responsive heading");
    }
    assert.match(body, /\.status-code\s*\{\s*margin: 0;/);
    assert.match(body, /\.panel-header\s*\{[^}]*padding: calc\(var\(--spacing\) \* 4\) calc\(var\(--spacing\) \* 6\);/,
        "the panel header uses the roomier block padding and shared inline alignment");
    assert.match(body, /\.content\s*\{\s*--content-padding: calc\(var\(--spacing\) \* 6\);\s*padding: var\(--content-padding\);\s*\}/,
        "mobile content keeps the same padding on every side");
    assert.match(body, /\.lead\s*\{[^}]*margin: 0;\s*margin-top: calc\(var\(--spacing\) \* 3\);/);
    assert.match(body, /\.target, \.retry\s*\{ margin-top: calc\(var\(--spacing\) \* 5\); \}/,
        "the address and retry boxes share the same top spacing");
    assert.match(body, /--spacing: 0\.25rem;/);
    assert.match(body, /@media \(min-width: 40rem\)\s*\{[^}]*body \{[^}]*\}\s*\.content \{[^}]*padding-inline: calc\(var\(--spacing\) \* 6\);/,
        "desktop content aligns with the panel header while keeping its larger vertical spacing");
    for (const [, spacing] of body.matchAll(/(?:margin(?:-top)?|padding(?:-left|-inline)?|gap|inset):\s*([^;]+);/g)) {
        const remainder = spacing.replace(/calc\(var\(--spacing\) \* -?\d+(?:\.5)?\)|var\(--content-padding\)|\b0\b/g, "").trim();
        assert.equal(remainder, "", "spacing uses the shared quarter-rem unit");
    }
    for (const [, factor] of body.matchAll(/calc\(var\(--spacing\) \* (-?\d+(?:\.\d+)?)\)/g)) {
        const magnitude = Math.abs(Number(factor));
        assert.ok(magnitude <= 4 ? Number.isInteger(magnitude * 2) : Number.isInteger(magnitude),
            "spacing allows half steps up to four and whole steps above four");
    }
    assert.match(body, /main \{ width: min\(100%, calc\(var\(--spacing\) \* 160\)\); \}/);
    assert.match(body, /max-width: calc\(var\(--spacing\) \* 136\);/);
    assert.match(body, /\.retry-dot\s*\{[^}]*width: calc\(var\(--spacing\) \* 2\);\s*height: calc\(var\(--spacing\) \* 2\);/);
    for (const name of Object.keys(typeScale)) {
        assert.ok(body.includes(`line-height: var(--text-${name}--line-height)`));
    }
    assert.match(body, /\.retry--warning\s*\{[^}]*color: var\(--warning\)/,
        "retry text shares the warning color with the pulse");
    assert.match(body, /prefers-reduced-motion: reduce/);
    assert.match(body, /role="status" aria-live="polite"/);
    assert.ok(body.indexOf('class="checks"') < body.indexOf('class="retry retry--warning"'),
        "reconnection stays after the guidance");
    assert.match(body, /animation: retry-pulse/, "the retry indicator communicates continuous work");
    assert.doesNotMatch(body, /Technical details/);
    assert.match(body, /color-scheme: dark;/);
    assert.match(body, /<meta name="color-scheme" content="dark">/);
    assert.match(body, /--page: var\(--zinc-950\)/);
    assert.match(body, /--panel: var\(--zinc-900\)/);
    assert.doesNotMatch(body, /prefers-color-scheme|light dark/,
        "the page stays dark regardless of the browser preference");

    assert.match(body, /data-ektokit-proxy-status="502"/, "the page exposes its current state");
    assert.ok(body.includes(RELOAD_CLIENT), "the status page uses the shared SSE client");
    assert.doesNotMatch(body, /fetch\(location\.href/, "the browser does not poll Ghost");
});

test("shows a waiting state while Ghost responds with maintenance 503", async (t) => {
    const ghost = await fakeGhost();
    let ghostClosed = false;
    t.after(async () => {
        if (!ghostClosed) await ghost.close();
    });

    ghost.setStatus(503);

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx, { version: "1.0.0" });
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const response = /** @type {any} */ (await request(`${origin}/`));
    const body = response.body.toString("utf8");

    assert.equal(response.status, 503);
    assert.match(body, /<title>Ghost is not ready · EktoKit<\/title>/);
    assert.match(body, /503 · Service Unavailable/);
    assert.match(body, /<p class="status-code">503 · Service Unavailable<\/p>\s*<h1>/);
    assert.doesNotMatch(body, /eyebrow|brand-lockup|>Ghost proxy</);
    assert.match(body, /Ghost responded, but the site is not available yet:/);
    assert.match(body, /<h2 id="checks-title">What to do<\/h2>/);
    assert.match(body, /If Ghost is starting, wait a moment\. If this persists, check its logs\./);
    assert.doesNotMatch(body, /No action is needed|Ghost is running and the proxy is configured/);
    assert.match(body, /Waiting for Ghost to be ready…/);
    assert.match(body, /retry retry--warning/);
    assert.match(body, /data-ektokit-proxy-status="503"/);
    assert.match(body, /color-scheme: dark;/);
    assert.match(body, /<meta name="color-scheme" content="dark">/);
    assert.doesNotMatch(body, /prefers-color-scheme|light dark/);
    assert.ok(body.includes(RELOAD_CLIENT), "the waiting page uses the shared SSE client");
    assert.doesNotMatch(body, /fetch\(location\.href/);
    assert.doesNotMatch(body, /We’ll be right back/, "Ghost's maintenance page is replaced");
    assert.doesNotMatch(body, /Trying to reconnect/, "503 is waiting, not reconnecting");

    const waitingHead = /** @type {any} */ (await request(`${origin}/`, { method: "HEAD" }));
    assert.equal(waitingHead.status, 503);
    assert.equal(waitingHead.body.length, 0);

    ghost.setStatus(200);
    const ready = /** @type {any} */ (await request(`${origin}/`, { method: "HEAD" }));
    assert.equal(ready.status, 200, "the next request can observe that Ghost is ready");

    await ghost.close();
    ghostClosed = true;

    const unreachable = /** @type {any} */ (await request(`${origin}/`));
    assert.equal(unreachable.status, 502);
    assert.match(unreachable.body.toString("utf8"), /retry retry--warning/);
});

test("reports local URLs and optional network exposure on the bound port", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);

    const localOnly = createDevServer(ctx, { exposed: false });
    const localUrls = await localOnly.start(0);
    t.after(() => localOnly.close());

    assert.equal(localUrls.network, null);
    assert.equal(localUrls.proxy, ghost.origin);
    assert.equal(localUrls.local, `http://localhost:${localUrls.port}`);

    const exposed = createDevServer(ctx, { exposed: true });
    const exposedUrls = await exposed.start(0);
    t.after(() => exposed.close());

    // A CI container may have no LAN interface; only the shape is asserted.
    if (exposedUrls.network !== null) {
        assert.match(exposedUrls.network, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    }
});

test("injects before </head> when there is no body tag", () => {
    const injected = injectClient("<html><head><title>x</title></head></html>");

    assert.ok(injected.includes(RELOAD_CLIENT));
    assert.ok(injected.indexOf(RELOAD_CLIENT) < injected.indexOf("</head>"));
    assert.equal(injectClient(injected), injected, "injection is not repeated");
});

// Ghost builds every absolute URL from the `url` in its own config, which is
// the same value `server.proxy` points at. Left alone, a phone reaching EktoKit
// over the LAN receives `http://localhost:2368/...` and resolves it against
// itself, so no asset loads. Each response is rewritten to the origin its own
// client used.

test("rewrites Ghost's origin to the origin the client used", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const response = /** @type {any} */ (await request(`${origin}/absolute`));
    const body = response.body.toString("utf8");

    assert.ok(!body.includes(ghost.origin), "no reference to Ghost's own origin survives");
    assert.ok(body.includes(`${origin}/assets/built/style.css`), "stylesheet");
    assert.ok(body.includes(`${origin}/content/images/hero.jpg`), "image");
    assert.ok(body.includes(`${origin}/sobre/`), "link");
    assert.ok(body.includes(`${origin}/post/`), "canonical");
    assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(body));
});

test("rewrites the escaped form Ghost uses inside JSON-LD", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const body = /** @type {any} */ (await request(`${origin}/absolute`)).body.toString("utf8");
    const escaped = origin.split("/").join("\\/");

    assert.ok(body.includes(`${escaped}\\/post\\/`), "the JSON-LD url is rewritten, escaping intact");
    assert.ok(!body.includes(ghost.origin.split("/").join("\\/")), "no escaped Ghost origin survives");
});

test("gives each client its own origin, so --host and localhost work at once", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");

    // Same server, same page, two clients that arrived by different origins.
    const desktop = /** @type {any} */ (await request(`${origin}/absolute`));
    const phone = /** @type {any} */ (
        await request(`${origin}/absolute`, { headers: { host: "192.168.1.50:3000" } })
    );

    assert.ok(desktop.body.toString("utf8").includes(`${origin}/content/images/hero.jpg`));
    assert.ok(
        phone.body.toString("utf8").includes("http://192.168.1.50:3000/content/images/hero.jpg"),
        "the phone gets the address it can actually reach",
    );
});

test("refuses a Host header that is not a plain host:port", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const response = /** @type {any} */ (
        await request(`${origin}/absolute`, {
            headers: { host: 'evil"><script>alert(1)</script>' },
        })
    );
    const body = response.body.toString("utf8");

    // The Host header is client-controlled, so it is never written into the
    // page unverified; the configured local origin is used instead.
    assert.ok(!body.includes("<script>alert(1)</script>"), "nothing is injected");
    assert.ok(body.includes("http://localhost:3000/content/images/hero.jpg"), "falls back");
});

test("leaves Ghost admin untouched", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const body = /** @type {any} */ (await request(`${origin}/ghost/`)).body.toString("utf8");

    // The admin is a single-page app that builds its own API calls; rewriting
    // its markup is a risk with no upside for theme development.
    assert.ok(body.includes(`${ghost.origin}/assets/built/style.css`), "admin markup is verbatim");

    // It does not get the reload client either. An admin page can hold an
    // unsaved post, and saving a theme file must not reload it away.
    assert.ok(!body.includes(RELOAD_CLIENT), "admin does not get the reload client");
});

// A page left open across a restart of `ektokit dev` shows whatever was on screen
// when the server stopped and misses edits made while it was down. Each
// connection announces which run of the server answered it, so the client can
// tell a restart from a stream that merely dropped.

test("announces the server instance on every connection", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const first = await readHello(`${origin}${RELOAD_STREAM}`);
    const second = await readHello(`${origin}${RELOAD_STREAM}`);

    assert.match(first, /^[0-9a-f-]{36}$/, "the id is announced on connect");
    assert.equal(second, first, "the same run always announces the same id");
});

test("a restarted server announces a different instance", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);

    const before = createDevServer(ctx);
    const first = await before.start(0);
    const firstId = await readHello(`${first.local.replace("localhost", "127.0.0.1")}${RELOAD_STREAM}`);
    await before.close();

    // The same config starts a new server instance on another available port.
    const after = createDevServer(ctx);
    const second = await after.start(0);
    t.after(() => after.close());
    const secondId = await readHello(
        `${second.local.replace("localhost", "127.0.0.1")}${RELOAD_STREAM}`,
    );

    assert.notEqual(secondId, firstId, "the client can see it is talking to a new server");
});

test("the client reloads on a new instance and stays put on the same one", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const source = /** @type {any} */ (await request(`${origin}${RELOAD_CLIENT}`)).body.toString(
        "utf8",
    );

    const client = reloadClientHarness(source);
    client.emit("hello", "first-run");
    assert.equal(client.reloads, 0, "the first connection establishes the instance");
    client.emit("hello", "first-run");
    assert.equal(client.reloads, 0, "reconnecting to the same server does not reload");
    client.emit("hello", "second-run");
    assert.equal(client.reloads, 1, "a different server instance reloads the page");
    client.emit("hello", "third-run");
    client.emit("reload");
    assert.equal(client.reloads, 1, "an ongoing navigation is not repeated");
});

test("the client reloads only when the shared proxy state differs from its page", async (t) => {
    const ghost = await fakeGhost();
    t.after(() => ghost.close());

    const ctx = await devContext(ghost.origin);
    const server = createDevServer(ctx);
    const urls = await server.start(0);
    t.after(() => server.close());

    const origin = urls.local.replace("localhost", "127.0.0.1");
    const source = /** @type {any} */ (await request(`${origin}${RELOAD_CLIENT}`)).body.toString(
        "utf8",
    );

    const ready = reloadClientHarness(source);
    assert.equal(ready.streamUrl, RELOAD_STREAM);
    assert.doesNotMatch(source, /fetch\(|setTimeout\(|visibilitychange/, "the client only listens");
    ready.emit("proxy-status", "ready");
    assert.equal(ready.reloads, 0, "a current state stays on the page");
    ready.emit("proxy-status", "502");
    ready.emit("reload");
    assert.equal(ready.reloads, 1, "concurrent reasons still navigate only once");

    const unreachable = reloadClientHarness(source, { status: "502" });
    unreachable.emit("proxy-status", "502");
    assert.equal(unreachable.reloads, 0, "502 does not reload into itself");
    unreachable.emit("proxy-status", "503");
    assert.equal(unreachable.reloads, 1, "502 advances to the waiting state");

    const waiting = reloadClientHarness(source, { status: "503" });
    waiting.emit("proxy-status", "503");
    assert.equal(waiting.reloads, 0, "503 does not reload into itself");
    waiting.emit("proxy-status", "ready");
    assert.equal(waiting.reloads, 1, "503 advances to the real site");
});

test("one proxy monitor serves every SSE client and snapshots its current state", async (t) => {
    let probes = 0;
    /** @type {(status: "ready") => void} */
    let resolveProbe;
    const pendingProbe = new Promise((resolve) => {
        resolveProbe = resolve;
    });
    const hub = createReloadHub({
        intervalMs: 1000,
        probe: async () => {
            probes += 1;
            return pendingProbe;
        },
    });
    t.after(() => hub.close());

    const first = reloadHubClient(hub);
    const second = reloadHubClient(hub);

    assert.equal(probes, 1, "two clients share the in-flight probe");
    resolveProbe("ready");
    await waitFor(() => first.output.includes("event: proxy-status"));

    assert.match(first.output, /event: proxy-status\ndata: ready/);
    assert.match(second.output, /event: proxy-status\ndata: ready/);

    const third = reloadHubClient(hub);
    assert.match(third.output, /event: proxy-status\ndata: ready/, "a new client gets a snapshot");
    assert.equal(probes, 1, "a new client does not create another monitor");

    first.close();
    second.close();
    third.close();
    assert.equal(hub.size, 0);
    hub.close();
});

test("the shared monitor confirms consecutive failures and broadcasts only state transitions", async (t) => {
    const pending = [];
    const hub = createReloadHub({
        intervalMs: 1,
        probe: () => new Promise((resolve) => pending.push(resolve)),
    });
    t.after(() => hub.close());
    const client = reloadHubClient(hub);
    const events = () => [...client.output.matchAll(/event: proxy-status\ndata: (ready|502|503)/g)]
        .map((match) => match[1]);
    const probe = async (status) => {
        await waitFor(() => pending.length > 0);
        pending.shift()(status);
        await new Promise((resolve) => setImmediate(resolve));
    };

    await probe("ready");
    assert.deepEqual(events(), ["ready"]);
    await probe("502");
    assert.deepEqual(events(), ["ready"], "one failure is not published");
    await probe("ready");
    assert.deepEqual(events(), ["ready"], "recovery resets the failure count without duplicating the state");
    await probe("502");
    assert.deepEqual(events(), ["ready"], "a failure after recovery starts a new count");
    await probe("502");
    assert.deepEqual(events(), ["ready", "502"], "the second consecutive failure is published");
    await probe("502");
    assert.deepEqual(events(), ["ready", "502"], "an unchanged failure is not repeated");
    await probe("503");
    await probe("ready");
    assert.deepEqual(events(), ["ready", "502", "503", "ready"]);
});

test("the shared monitor stops and aborts its probe with the last SSE client", async (t) => {
    let aborted = false;
    const hub = createReloadHub({
        probe: (signal) =>
            new Promise((resolve) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        aborted = true;
                        resolve("502");
                    },
                    { once: true },
                );
            }),
    });
    t.after(() => hub.close());
    const client = reloadHubClient(hub);

    client.close();
    await waitFor(() => aborted);

    assert.equal(hub.size, 0);
    assert.doesNotMatch(client.output, /event: proxy-status/, "an aborted result is not published");
    hub.close();
});
