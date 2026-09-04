import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { wantsHost } from "../src/cli.js";
import { isSupportedNode, unsupportedNodeMessage } from "../src/node-version.js";
import { validateConfig } from "../src/config.js";
import { binPath, makeProject, packageRoot } from "./helpers.js";

const exec = promisify(execFile);

/**
 * @param {string[]} argv
 */
const flags = (argv) => new Set(argv);

test("--host enables network exposure", () => {
    assert.equal(wantsHost(flags(["dev", "--host"])), true);
});

test("without the flag the config decides", () => {
    assert.equal(wantsHost(flags(["dev"])), undefined, "undefined means: use the config");

    const off = validateConfig({}, { root: "/theme" });
    const on = validateConfig({ server: { host: true } }, { root: "/theme" });

    assert.equal(off.server.host, false, "exposure is off unless asked for");
    assert.equal(on.server.host, true);
});

// These are version-parser cases, not executions on the listed runtimes.

test("the Node floor accepts 22 and everything above it", () => {
    for (const version of ["22.0.0", "22.23.1", "24.20.0", "26.8.1", "30.0.0"]) {
        assert.equal(isSupportedNode(version), true, version);
    }
});

test("the Node floor refuses anything below 22", () => {
    for (const version of ["18.20.8", "20.20.2", "21.7.3", "not-a-version"]) {
        assert.equal(isSupportedNode(version), false, version);
    }
});

test("the refusal says what is needed, what is there, and where to get it", () => {
    const message = unsupportedNodeMessage("20.20.2");

    assert.match(message, /needs Node\.js 22 or newer/);
    assert.match(message, /this is v20\.20\.2/);
    assert.match(message, /nodejs\.org/);

    // Whoever hits this runs Ghost too, and would otherwise wonder whether the
    // upgrade costs them a second install.
    assert.match(message, /Ghost 6 needs Node\.js 22 as well/);
});

test("help flags succeed without a theme config", async () => {
    const root = await makeProject({});
    for (const flag of ["--help", "-h"]) {
        const { stdout, stderr } = await exec(process.execPath, [binPath, flag], { cwd: root, timeout: 5000 });
        assert.match(stdout, /Usage: ektokit <command>/);
        for (const command of ["dev", "build", "zip"]) assert.ok(stdout.includes(command));
        assert.match(stdout, /--host/);
        assert.equal(stderr, "");
    }
});

test("version flags print the package version without requiring a config", async () => {
    const root = await makeProject({});
    const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
        const { stdout, stderr } = await exec(process.execPath, [binPath, flag], { cwd: root, timeout: 5000 });
        assert.equal(stdout.trim(), version);
        assert.equal(stderr, "");
    }
});

test("no command prints usage and exits with code one", async () => {
    const root = await makeProject({});
    await assert.rejects(exec(process.execPath, [binPath], { cwd: root, timeout: 5000 }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /Usage: ektokit <command>/);
        assert.equal(error.stderr, "");
        return true;
    });
});

test("an unknown command exits with readable guidance", async () => {
    const root = await makeProject({});
    await assert.rejects(exec(process.execPath, [binPath, "unknown"], { cwd: root, timeout: 5000 }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unknown command: unknown/);
        assert.match(error.stderr, /ektokit --help/);
        assert.doesNotMatch(error.stderr, /No ektokit\.config\.mjs|\n\s+at /);
        return true;
    });
});
