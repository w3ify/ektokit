import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { dev } from "../src/commands/dev.js";
import { RELOAD_CLIENT, RELOAD_STREAM } from "../src/server/reload.js";
import { exists, makeLogger, makeProject, read } from "./helpers.js";

async function listen(server, port = 0) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    return server.address().port;
}

async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

async function availablePort() {
    const reservation = http.createServer();
    const port = await listen(reservation);
    await close(reservation);
    return port;
}

async function waitFor(condition) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for development output");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function project(port, proxy, css = ".initial { color: red; }\n") {
    return makeProject({
        "package.json": '{"name":"theme"}',
        "ektokit.config.mjs": `export default ${JSON.stringify({
            server: { port, proxy },
            assets: {
                css: { entries: [{ input: "css/style.css", output: "built/style.css" }] },
                js: { entries: [{ input: "js/global.js", output: "built/global.js" }] },
            },
        })};`,
        ...(css === null ? {} : { "assets/css/style.css": css }),
        "assets/js/global.js": 'console.log("initial");\n',
        "index.hbs": "<main>Theme</main>\n",
    });
}

async function startDev(t, root) {
    const { logger, stdout, stderr } = makeLogger();
    const signals = ["SIGINT", "SIGTERM"];
    const previous = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
    let session;
    let stopped = false;
    const stop = async () => {
        if (!session || stopped) return;
        stopped = true;
        await session.stop();
    };
    t.after(async () => {
        try {
            await stop();
        } finally {
            // The command owns process-level handlers; keep this test's session isolated.
            for (const signal of signals) {
                for (const listener of process.listeners(signal)) {
                    if (!previous.get(signal).has(listener)) process.removeListener(signal, listener);
                }
            }
        }
    });
    session = await dev({ root, logger, version: "1.0.0" });
    return { session, stdout, stderr, stop };
}

test("dev integrates initial build, proxy, watcher, SSE reload and shutdown", { timeout: 15000 }, async (t) => {
    const ghost = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(req.method === "HEAD" ? undefined : "<html><body><main>Theme</main></body></html>");
    });
    const ghostPort = await listen(ghost);
    t.after(() => close(ghost));
    const port = await availablePort();
    const root = await project(port, `http://127.0.0.1:${ghostPort}`);
    const { session, stdout, stderr, stop } = await startDev(t, root);
    const origin = `http://127.0.0.1:${port}`;
    const broadcastReload = session.server.reload;
    let broadcasts = 0;
    session.server.reload = () => {
        broadcasts += 1;
        broadcastReload();
    };

    assert.equal(session.urls.port, port, "the command uses the configured port");
    assert.match(stdout(), /Watching for changes/);
    assert.equal(stderr(), "");
    assert.match(await read(path.join(root, "assets/built/style.css")), /\.initial/);
    assert.match(await read(path.join(root, "assets/built/global.js")), /initial/);
    const response = await fetch(origin, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(RELOAD_CLIENT));

    let stream = "";
    const request = http.get(`${origin}${RELOAD_STREAM}`, (res) => {
        res.on("data", (chunk) => { stream += chunk.toString(); });
    });
    let streamError;
    request.on("error", (error) => { streamError = error; });
    t.after(() => request.destroy());
    await waitFor(() => stream.includes("event: hello"));
    const reloads = () => (stream.match(/event: reload\n/g) ?? []).length;

    const input = path.join(root, "assets/css/style.css");
    const output = path.join(root, "assets/built/style.css");
    await fs.writeFile(input, ".changed { color: blue; }\n");
    await waitFor(() => reloads() === 1);
    await session.watcher.idle();
    const successful = await read(output);
    assert.match(successful, /\.changed/);
    assert.equal(broadcasts, 1);

    await fs.writeFile(input, ".broken {\n");
    await waitFor(() => stderr().includes("CSS build failed"));
    await session.watcher.idle();
    assert.equal(broadcasts, 1, "the failed build never asks the server to broadcast a reload");
    assert.equal(reloads(), 1);
    assert.equal(await read(output), successful);

    await fs.writeFile(input, ".fixed { color: green; }\n");
    await waitFor(() => reloads() === 2);
    await session.watcher.idle();
    assert.match(await read(output), /\.fixed/);
    assert.equal(streamError, undefined);
    request.destroy();
    await stop();

    const replacement = http.createServer();
    try {
        assert.equal(await listen(replacement, port), port, "shutdown releases the configured port");
    } finally {
        await close(replacement);
    }
});

test("dev stays available with a missing input and unreachable Ghost, then rebuilds on creation", { timeout: 15000 }, async (t) => {
    const unavailable = http.createServer();
    const ghostPort = await listen(unavailable);
    const port = await availablePort();
    await close(unavailable);
    const root = await project(port, `http://127.0.0.1:${ghostPort}`, null);
    const { session, stdout, stderr } = await startDev(t, root);

    assert.match(stderr(), /CSS input not found: assets\/css\/style\.css/);
    assert.match(stdout(), /Ghost did not answer/);
    assert.match(stdout(), /Watching for changes/);
    assert.match(await read(path.join(root, "assets/built/global.js")), /initial/);
    assert.equal(await exists(path.join(root, "assets/built/style.css")), false);
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 502);
    assert.ok((await response.text()).includes(RELOAD_CLIENT));

    const before = stderr();
    await fs.mkdir(path.join(root, "assets/css"), { recursive: true });
    await fs.writeFile(path.join(root, "assets/css/style.css"), ".recovered { color: green; }\n");
    await waitFor(() => /\bReload\b/.test(stdout()));
    await session.watcher.idle();
    assert.match(await read(path.join(root, "assets/built/style.css")), /\.recovered/);
    assert.equal(stderr(), before);
});
