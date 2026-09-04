import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

import { createContext, runTasks } from "../src/context.js";
import { createZip, resolveZipName } from "../src/archive/zip.js";
import { binPath, exists, makeLogger, makeProject } from "./helpers.js";

const run = promisify(execFile);

const configFor = (zipConfig) => `export default {
    assets: {
        css: { processor: "vanilla", entries: [{ input: "css/style.css", output: "built/style.css" }] },
        js: { entries: [{ input: "js/global.js", output: "built/global.js" }] },
    },
    zip: ${zipConfig},
};
`;

const ignore = `{
        ignore: [
            ".gitignore",
            "node_modules/**",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
            ".vscode/**",
            ".DS_Store",
        ],
    }`;

/**
 * @param {string} zipConfig
 * @param {Record<string, string>} [extra]
 * @param {string} [pkg]
 */
async function zipProject(zipConfig, extra = {}, pkg = '{ "name": "theme", "type": "module" }') {
    return makeProject({
        "package.json": pkg,
        "ektokit.config.mjs": configFor(zipConfig),
        "index.hbs": '{{!< default}}\n<main class="p-8"></main>\n',
        "default.hbs": "<html><body>{{{body}}}</body></html>\n",
        "partials/header.hbs": "<header></header>\n",
        "assets/css/style.css": ".a { color: red; }\n",
        "assets/js/global.js": 'console.log("global");\n',
        ...extra,
    });
}

/**
 * @param {string} root
 */
async function contextFor(root) {
    const { logger } = makeLogger();
    return createContext({ root, mode: "production", logger });
}

/**
 * @param {string} file
 */
async function readZip(file) {
    return unzipSync(await fs.readFile(file));
}

/**
 * @param {string} file
 */
async function listZip(file) {
    return Object.keys(await readZip(file)).sort();
}

test("names the archive after package.json by default", async () => {
    const root = await zipProject(ignore);
    const ctx = await contextFor(root);
    const result = await createZip(ctx);

    assert.equal(result.name, "theme.zip");
    assert.equal(result.path, path.join(root, "dist", "theme.zip"));
    assert.ok(await exists(result.path));
});

test("zip.name overrides package.json and the extension is added", async () => {
    const root = await zipProject('{ name: "custom-theme" }');
    const ctx = await contextFor(root);
    const result = await createZip(ctx);

    assert.equal(result.name, "custom-theme.zip");
    assert.ok(await exists(path.join(root, "dist", "custom-theme.zip")));
});

test("refuses an unsafe package.json name before writing outside dist", async () => {
    const root = await zipProject("{}", {}, '{ "name": "../outside", "type": "module" }');
    const ctx = await contextFor(root);

    assert.throws(() => resolveZipName(ctx), /package\.json "name" must be a file name, not a path/);
    await assert.rejects(createZip(ctx), /package\.json "name" must be a file name, not a path/);
    assert.equal(await exists(path.join(root, "dist")), false);
});

test("refuses to hide theme content inside dist", async () => {
    const root = await zipProject(ignore, { "dist/readme.txt": "not an archive\n" });
    const ctx = await contextFor(root);

    await assert.rejects(createZip(ctx), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /dist must be dedicated to ZIP archives/);
        assert.match(error.detail, /dist\/readme\.txt/);
        assert.match(error.hint, /Move it out of dist/);
        return true;
    });

    assert.equal(await fs.readFile(path.join(root, "dist", "readme.txt"), "utf8"), "not an archive\n");
    assert.equal(await exists(path.join(root, "dist", "theme.zip")), false);
});

test("keeps existing archives in the dedicated dist directory", async () => {
    const root = await zipProject(ignore, { "dist/previous.zip": "previous" });
    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    assert.equal(await fs.readFile(path.join(root, "dist", "previous.zip"), "utf8"), "previous");
    assert.ok(!entries.some((entry) => entry.startsWith("dist/")));
});

test("ignores OS clutter inside dist instead of refusing the archive", async () => {
    const root = await zipProject(ignore, {
        "dist/.DS_Store": "mac clutter",
        "dist/Thumbs.db": "windows clutter",
        "dist/desktop.ini": "windows clutter",
    });

    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    assert.ok(await exists(path.join(root, "dist", "theme.zip")));
    assert.ok(!entries.some((entry) => entry.startsWith("dist/")));
});

test("recognizes the fixed dist directory without case", async () => {
    const root = await zipProject(ignore, { "Dist/previous.zip": "previous" });
    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    assert.ok(!entries.some((entry) => entry.toLowerCase().startsWith("dist/")));
});

test("fails clearly when no name is available", async () => {
    const root = await zipProject(ignore, {}, '{ "type": "module" }');
    const ctx = await contextFor(root);

    // Ghost requires the field, so the message names the broken theme rather
    // than the ZIP step that noticed it.
    assert.throws(() => resolveZipName(ctx), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /package\.json is missing a "name"/);
        assert.match(error.detail, /Ghost requires it/);
        assert.match(error.hint, /zip\.name/);
        return true;
    });

    await assert.rejects(createZip(ctx), /package\.json is missing a "name"/);
    assert.equal(await exists(path.join(root, "dist")), false, "no partial output directory");
});

test("keeps config and theme sources while applying explicit exclusions", async () => {
    const root = await zipProject(ignore, {
        ".gitignore": "node_modules\n",
        ".vscode/settings.json": "{}\n",
        // One lockfile per package manager: whichever the theme author used,
        // the example config in the README covers it.
        "package-lock.json": "{}\n",
        "yarn.lock": "# lock\n",
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
        "bun.lock": "{}\n",
        "node_modules/pkg/index.js": "export default 1;\n",
        "assets/images/logo.png": "binary-ish",
    });

    const ctx = await contextFor(root);

    await runTasks(ctx, ["css", "js"]);

    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    assert.ok(entries.includes("ektokit.config.mjs"), "ektokit.config.mjs stays in the ZIP");
    assert.ok(entries.includes("package.json"));
    assert.ok(entries.includes("index.hbs"));
    assert.ok(entries.includes("partials/header.hbs"));
    assert.ok(entries.includes("assets/css/style.css"), "source CSS is kept");
    assert.ok(entries.includes("assets/js/global.js"), "source JS is kept");
    assert.ok(entries.includes("assets/built/style.css"), "built assets are included");
    assert.ok(entries.includes("assets/images/logo.png"));

    for (const excluded of [
        ".gitignore",
        ".vscode/settings.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
        "node_modules/pkg/index.js",
    ]) {
        assert.ok(!entries.includes(excluded), `${excluded} must not be archived`);
    }

    assert.ok(!entries.some((entry) => entry.startsWith("dist/")), "the ZIP never contains itself");
});

test("keeps dot-files that are not ignored", async () => {
    const root = await zipProject('{ ignore: [".vscode/**"] }', {
        ".editorconfig": "root = true\n",
        ".nvmrc": "22\n",
        ".github/workflows/ci.yml": "name: ci\n",
        ".vscode/settings.json": "{}\n",
    });

    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    assert.ok(entries.includes(".editorconfig"), "dot-files are no longer dropped wholesale");
    assert.ok(entries.includes(".nvmrc"));
    assert.ok(entries.includes(".github/workflows/ci.yml"), "hidden directories are walked");
    assert.ok(!entries.includes(".vscode/settings.json"), "zip.ignore still decides");
});

test("never archives node_modules, .git or OS clutter, even with an empty ignore list", async () => {
    const root = await zipProject("{}", {
        "node_modules/pkg/index.js": "export default 1;\n",
        "node_modules/.bin/ektokit": "#!/usr/bin/env node\n",
        ".git/config": "[core]\n",
        ".git/objects/ab/cdef": "binary",
        ".DS_Store": "mac clutter",
        "assets/.DS_Store": "mac clutter",
        "Thumbs.db": "windows clutter",
        "desktop.ini": "windows clutter",
        ".npmrc": "//registry.npmjs.org/:_authToken=secret\n",
        ".env": "GHOST_KEY=secret\n",
        ".env.local": "GHOST_KEY=secret\n",
        "__MACOSX/._index.hbs": "resource fork",
    });

    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);
    const entries = await listZip(file);

    for (const excluded of [
        "node_modules/pkg/index.js",
        "node_modules/.bin/ektokit",
        ".git/config",
        ".git/objects/ab/cdef",
        ".DS_Store",
        "assets/.DS_Store",
        "Thumbs.db",
        "desktop.ini",
        ".npmrc",
        ".env",
        ".env.local",
        "__MACOSX/._index.hbs",
    ]) {
        assert.ok(!entries.includes(excluded), `${excluded} must never be archived`);
    }

    assert.ok(entries.includes("index.hbs"), "the theme itself is still archived");
    assert.ok(entries.includes("ektokit.config.mjs"));
});

test("archives binary files without corrupting them", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x10]);
    const root = await zipProject(ignore);

    await fs.mkdir(path.join(root, "assets/images"), { recursive: true });
    await fs.writeFile(path.join(root, "assets/images/logo.png"), png);

    const ctx = await contextFor(root);
    const { path: file } = await createZip(ctx);

    const entries = await readZip(file);

    assert.deepEqual(Buffer.from(entries["assets/images/logo.png"]), png);
});

test("ektokit zip runs a production build and exits zero", async () => {
    const root = await zipProject(ignore, {
        "assets/built/style.css": "/* stale CSS */",
        "assets/built/global.js": "// stale JavaScript",
    });
    const { stdout } = await run(process.execPath, [binPath, "zip"], { cwd: root });

    assert.match(stdout, /✓ ZIP/);
    assert.match(stdout, /\d+ files → dist\/theme\.zip/);

    const built = await fs.readFile(path.join(root, "assets/built/global.js"), "utf8");

    assert.ok(!built.includes("\n"), "production JavaScript is minified");
    const archive = await readZip(path.join(root, "dist", "theme.zip"));
    const css = await fs.readFile(path.join(root, "assets/built/style.css"), "utf8");
    assert.equal(Buffer.from(archive["assets/built/global.js"]).toString(), built);
    assert.equal(Buffer.from(archive["assets/built/style.css"]).toString(), css);
    assert.match(built, /global/);
    assert.match(css, /\.a\{/);
    assert.doesNotMatch(`${built}\n${css}`, /stale/);
});

for (const previousArchive of [false, true]) {
    test(`a failed ZIP rename removes its temporary file ${previousArchive ? "and preserves the previous archive" : "without leaving an archive"}`, async (t) => {
        const root = await zipProject("{}");
        const ctx = await contextFor(root);
        const target = path.join(root, "dist", "theme.zip");
        const previous = previousArchive ? await fs.readFile((await createZip(ctx)).path) : null;
        const rename = fs.rename;
        let attempted = false;

        fs.rename = async (from, to) => {
            if (to !== target) return rename(from, to);
            attempted = true;
            assert.equal(from, `${target}.tmp`);
            assert.ok((await listZip(from)).includes("index.hbs"), "the temporary archive was completely written");
            throw Object.assign(new Error("Simulated rename failure"), { code: "EACCES" });
        };
        t.after(() => { fs.rename = rename; });

        await assert.rejects(createZip(ctx), (error) => {
            assert.equal(error.name, "EktoKitError");
            assert.equal(error.message, "Unable to create ZIP");
            assert.match(error.detail, /Simulated rename failure/);
            return true;
        });
        assert.equal(attempted, true);
        assert.equal(await exists(`${target}.tmp`), false);
        if (previousArchive) assert.deepEqual(await fs.readFile(target), previous);
        else assert.equal(await exists(target), false);
    });
}

test("a failed build produces no ZIP and a non-zero exit code", async () => {
    const root = await zipProject(ignore, { "assets/js/global.js": "const = ;\n" });

    await assert.rejects(
        run(process.execPath, [binPath, "zip"], { cwd: root }),
        (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /JS build failed/);
            return true;
        },
    );

    assert.equal(await exists(path.join(root, "dist", "theme.zip")), false);
});

for (const scenario of [
    {
        name: "vanilla CSS input",
        assets: { css: { entries: [{ input: "css/missing.css", output: "built/out.css" }] } },
        error: "CSS input not found: assets/css/missing.css",
        output: "assets/built/out.css",
        previous: ".previous { color: red; }\n",
    },
    {
        name: "Tailwind CSS input",
        assets: { css: { processor: "tailwind", entries: [{ input: "css/missing.css", output: "built/out.css" }] } },
        error: "CSS input not found: assets/css/missing.css",
        output: "assets/built/out.css",
        previous: ".previous { color: red; }\n",
    },
    {
        name: "JavaScript input",
        assets: { js: { entries: [{ input: "js/missing.js", output: "built/out.js" }] } },
        error: "JS input not found: assets/js/missing.js",
        output: "assets/built/out.js",
        previous: 'console.log("previous");\n',
    },
    {
        name: "member of a JavaScript input array",
        assets: { js: { entries: [{ input: ["js/present.js", "js/missing.js"], output: "built/out.js" }] } },
        error: "JS input not found: assets/js/missing.js",
        output: "assets/built/out.js",
        previous: 'console.log("previous");\n',
    },
]) {
    for (const previousBuild of [false, true]) {
        test(`missing ${scenario.name} fails build and zip ${previousBuild ? "with previous artifacts" : "on a clean theme"}`, async () => {
            const root = await makeProject({
                "package.json": '{ "name": "theme" }',
                "ektokit.config.mjs": `export default ${JSON.stringify({ assets: scenario.assets })};`,
                "index.hbs": "<main>Theme</main>\n",
                "assets/js/present.js": 'console.log("present");\n',
                ...(previousBuild ? { [scenario.output]: scenario.previous } : {}),
            });
            const archivePath = path.join(root, "dist/theme.zip");
            let previousZip;

            if (previousBuild) {
                await createZip(await contextFor(root));
                previousZip = await fs.readFile(archivePath);
            }

            for (const command of ["build", "zip"]) {
                await assert.rejects(run(process.execPath, [binPath, command], { cwd: root }), (error) => {
                    assert.equal(error.code, 1);
                    assert.ok(error.stderr.includes(scenario.error), error.stderr);
                    assert.match(error.stdout, /not generated/);
                    assert.ok(!error.stdout.includes("✓ ZIP"));
                    assert.ok(!error.stderr.includes("at Object."), "no raw stack trace");
                    return true;
                });

                if (previousBuild) {
                    assert.equal(await fs.readFile(path.join(root, scenario.output), "utf8"), scenario.previous);
                    assert.deepEqual(await fs.readFile(archivePath), previousZip);
                    assert.deepEqual(await fs.readdir(path.join(root, "dist")), ["theme.zip"]);
                } else {
                    assert.equal(await exists(path.join(root, scenario.output)), false);
                    assert.equal(await exists(path.join(root, "dist")), false);
                }
            }
        });
    }
}

for (const assets of [undefined, { css: { processor: "vanilla", entries: [] }, js: { entries: [] } }]) {
    test(`build and zip succeed with ${assets ? "explicitly empty" : "no"} asset entries`, async () => {
        const root = await makeProject({
            "package.json": '{ "name": "theme" }',
            "ektokit.config.mjs": `export default ${JSON.stringify(assets ? { assets } : {})};`,
            "index.hbs": "<main>Theme without a build pipeline</main>\n",
            "assets/css/style.css": ".already-built { color: red; }\n",
        });

        const build = await run(process.execPath, [binPath, "build"], { cwd: root });
        assert.match(build.stdout, /no assets declared/);
        assert.equal(await exists(path.join(root, "dist")), false);

        const zip = await run(process.execPath, [binPath, "zip"], { cwd: root });
        assert.match(zip.stdout, /no assets declared/);
        assert.match(zip.stdout, /✓ ZIP/);

        const archive = await readZip(path.join(root, "dist/theme.zip"));
        assert.ok(archive["index.hbs"]);
        assert.equal(Buffer.from(archive["assets/css/style.css"]).toString(), ".already-built { color: red; }\n");
    });
}

test("ektokit build exits zero and does not create a ZIP", async () => {
    const root = await zipProject(ignore);
    const { stdout } = await run(process.execPath, [binPath, "build"], { cwd: root });

    assert.match(stdout, /✓ CSS/);
    assert.match(stdout, /✓ JS /);
    assert.equal(await exists(path.join(root, "dist")), false);
});

test("a missing config exits non-zero with a readable message", async () => {
    const root = await makeProject({ "package.json": '{ "type": "module" }' });

    await assert.rejects(run(process.execPath, [binPath, "build"], { cwd: root }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /No ektokit\.config\.mjs found/);
        assert.ok(!error.stderr.includes("at Object."), "no raw stack trace");
        return true;
    });
});
