import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { createContext, runTasks, runTasksIsolated } from "../src/context.js";
import { exists, makeLogger, makeProject, read } from "./helpers.js";

const jsFiles = {
    "assets/js/lib/cards.js": 'console.log("cards");\n',
    "assets/js/single.js": 'console.log("single");\n',
    "assets/js/global.js": 'const testClasses = "flex items-center gap-4";\nconsole.log("EktoKit global");\n',
};

const vanillaConfig = `export default {
    assets: {
        css: {
            processor: "vanilla",
            entries: [{ input: "css/style.css", output: "built/style.css" }],
        },
        js: {
            entries: [
                { input: "js/global.js", output: "built/global.js" },
                {
                    input: ["js/lib/cards.js", "js/single.js"],
                    output: "built/single.js",
                },
            ],
        },
    },
};
`;

async function vanillaProject() {
    return makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": vanillaConfig,
        "assets/css/style.css": ".test-component {\n    display: flex;\n}\n",
        ...jsFiles,
    });
}

test("vanilla CSS builds without Tailwind installed", async () => {
    const root = await vanillaProject();
    const { logger } = makeLogger();
    // Development mode: this test is about not needing Tailwind installed,
    // not about minification, so it stays unminified and readable.
    const ctx = await createContext({ root, mode: "development", logger });

    await runTasks(ctx, ["css"]);

    const css = await read(path.join(root, "assets/built/style.css"));

    assert.match(css, /\.test-component/);
    assert.match(css, /display: flex/);
});

test("vanilla CSS reports syntax errors with file and line", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: { processor: "vanilla", entries: [{ input: "css/a.css", output: "built/a.css" }] },
            },
        };`,
        "assets/css/a.css": ".broken {\n    color: red;\n",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["css"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        // File and line live in the headline; the detail is the reason alone.
        assert.match(error.message, /CSS build failed: assets\/css\/a\.css:1/);
        assert.match(error.detail, /Unclosed block/);
        return true;
    });
});

test("a missing CSS input fails its development build without overwriting output", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: { processor: "vanilla", entries: [{ input: "css/missing.css", output: "built/a.css" }] },
            },
        };`,
        "assets/built/a.css": ".previous { color: red; }\n",
    });

    const { logger, stdout, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    const { results, failed } = await runTasksIsolated(ctx, ["css"]);

    assert.equal(failed, true);
    assert.equal(results[0].error.name, "EktoKitError");
    assert.match(stdout(), /✗ CSS .*not generated/);
    assert.match(stderr(), /CSS input not found: assets\/css\/missing\.css/);
    assert.equal(
        await read(path.join(root, "assets/built/a.css")),
        ".previous { color: red; }\n",
        "an existing output is left untouched",
    );
});

test("an empty CSS input builds an empty output", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: { processor: "vanilla", entries: [{ input: "css/empty.css", output: "built/a.css" }] },
            },
        };`,
        "assets/css/empty.css": "",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["css"]);

    assert.equal(await read(path.join(root, "assets/built/a.css")), "");
});

test("the tailwind processor explains missing dependencies", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: { processor: "tailwind", entries: [{ input: "css/a.css", output: "built/a.css" }] },
            },
        };`,
        "assets/css/a.css": '@import "tailwindcss";\n',
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["css"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /Tailwind processor is enabled/);
        assert.match(error.hint, /npm install -D tailwindcss @tailwindcss\/postcss/);
        return true;
    });
});

test("development JavaScript is concatenated in array order and not minified", async () => {
    const root = await vanillaProject();
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    await runTasks(ctx, ["js"]);

    const single = await read(path.join(root, "assets/built/single.js"));
    const global = await read(path.join(root, "assets/built/global.js"));

    // Files are separated the way Terser separates them when it emits the
    // same map as one program, so the two modes cannot disagree on where one
    // file ends. Everything else is the source exactly as written.
    assert.equal(single, 'console.log("cards");\n;\nconsole.log("single");\n');
    assert.match(global, /const testClasses = "flex items-center gap-4";/);
    assert.ok(single.indexOf("cards") < single.indexOf("single"));
});

test("production JavaScript is minified and keeps the concatenation order", async () => {
    const root = await vanillaProject();
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["js"]);

    const single = await read(path.join(root, "assets/built/single.js"));
    const global = await read(path.join(root, "assets/built/global.js"));

    assert.ok(!single.includes("\n\n"));
    assert.ok(single.length < 'console.log("cards");\nconsole.log("single");\n'.length);
    assert.ok(single.indexOf("cards") < single.indexOf("single"));
    assert.ok(!global.includes("const testClasses ="));
});

test("a bundle of already-minified vendors is minified too", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: {
                    entries: [
                        {
                            input: ["js/lib/vendor.min.js", "js/lightbox.js"],
                            output: "built/lightbox.js",
                        },
                    ],
                },
            },
        };`,
        // A license header the theme is obliged to keep when redistributing.
        "assets/js/lib/vendor.min.js":
            '/*! Vendor v1 | Licensed MIT */\n!function(){console.log("vendor")}();\n',
        "assets/js/lightbox.js": 'const lightboxOption = true;\nconsole.log("lightbox");\n',
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["js"]);

    const bundle = await read(path.join(root, "assets/built/lightbox.js"));

    // Production minifies every entry, with no per-entry opt-out.
    assert.ok(!bundle.includes("const lightboxOption ="), "the bundle is minified");

    // Which is only acceptable because Terser keeps `/*!` and `@license`
    // comments: re-minifying a vendor must not strip its license.
    assert.ok(bundle.includes("Licensed MIT"), "the vendor license survives");
});

test("a missing JavaScript input fails its development build without writing a partial bundle", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: { entries: [{ input: ["js/present.js", "js/missing.js"], output: "built/out.js" }] },
            },
        };`,
        "assets/js/present.js": 'console.log("present");\n',
        "assets/built/out.js": "// previous build\n",
    });

    const { logger, stdout, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    const { results, failed } = await runTasksIsolated(ctx, ["js"]);

    assert.equal(failed, true);
    assert.equal(results[0].error.name, "EktoKitError");
    assert.match(stdout(), /✗ JS .*not generated/);
    assert.match(stderr(), /JS input not found: assets\/js\/missing\.js/);
    assert.equal(
        await read(path.join(root, "assets/built/out.js")),
        "// previous build\n",
        "a half-assembled bundle is never written",
    );
});

test("an empty JavaScript input builds an empty output", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: { entries: [{ input: "js/empty.js", output: "built/out.js" }] },
            },
        };`,
        "assets/js/empty.js": "",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["js"]);

    assert.equal(await read(path.join(root, "assets/built/out.js")), "");
});

test("invalid JavaScript fails the production build", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: { entries: [{ input: "js/broken.js", output: "built/out.js" }] },
            },
        };`,
        "assets/js/broken.js": "const = ;\n",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["js"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /JS build failed/);
        return true;
    });
});

test("invalid JavaScript fails the development build too, naming file and line", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: { entries: [{ input: ["js/lib/vendor.js", "js/broken.js"], output: "built/out.js" }] },
            },
        };`,
        "assets/js/lib/vendor.js": "var ok = 1;\n",
        "assets/js/broken.js": "var fine = 1;\nfunction ( {\n",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    // Development must report syntax errors before writing a broken bundle.
    await assert.rejects(runTasks(ctx, ["js"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        // The map of files is what makes this possible: the error belongs to
        // the file that holds it, not to an offset in the joined bundle.
        assert.match(error.message, /JS build failed: assets\/js\/broken\.js:2/);
        return true;
    });

    assert.equal(await exists(path.join(root, "assets/built/out.js")), false, "nothing is written");
});

test("development separates files so concatenation cannot change their meaning", async () => {
    const root = await makeProject({
        "package.json": '{ "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: { entries: [{ input: ["js/a.js", "js/b.js"], output: "built/out.js" }] },
            },
        };`,
        // `a.js` ends in an expression and `b.js` opens with `(`. Joined by a
        // newline alone the two become a call, which parses and then throws at
        // runtime — a break that existed only in development.
        "assets/js/a.js": "globalThis.a = function () { return 1 }\n",
        "assets/js/b.js": "(function () { globalThis.ran = true; })()\n",
    });

    const { logger } = makeLogger();
    /** @type {Record<string, string>} */
    const built = {};

    for (const mode of ["development", "production"]) {
        const ctx = await createContext({ root, mode, logger });

        await runTasks(ctx, ["js"]);

        built[mode] = await read(path.join(root, "assets/built/out.js"));

        const globals = {};
        runInNewContext(built[mode], globals);
        assert.equal(globals.ran, true, `${mode} runs both files`);
    }

    // And development is still the source as written, not a regenerated copy:
    // a vendor that ships minified stays minified, and the theme's own
    // formatting is the formatting the author sees in the bundle.
    assert.ok(built.development.includes("function () { return 1 }"), "the spacing survives");
    assert.ok(!built.production.includes("function () { return 1 }"), "production does rewrite");
});

test("an input listed twice in one entry is concatenated once, at its first position", async () => {
    const root = await makeProject({
        "ektokit.config.mjs": `export default {
            assets: { js: { entries: [{ input: ["js/b.js", "js/a.js", "js/b.js"], output: "built/out.js" }] } },
        };`,
        "assets/js/a.js": 'record("a");\n',
        "assets/js/b.js": 'record("b");\n',
    });
    const { logger } = makeLogger();

    for (const mode of ["development", "production"]) {
        const ctx = await createContext({ root, mode, logger });
        await runTasks(ctx, ["js"]);
        const calls = [];
        runInNewContext(await read(path.join(root, "assets/built/out.js")), {
            record: (value) => calls.push(value),
        });
        assert.deepEqual(calls, ["b", "a"], `${mode} executes each input once, in first-occurrence order`);
    }
});

// An empty config must be distinguishable from a build that generated assets.

test("a config with no entries says so instead of going quiet", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default { server: { proxy: "http://localhost:2368" } };`,
    });

    const { logger, stdout } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    const results = await runTasks(ctx, ["css", "js"]);

    assert.equal(results.length, 0, "there was nothing to run");
    assert.match(stdout(), /⊘ Build: .*no assets declared in \.\/ektokit\.config\.mjs/);
});

test("development with no entries is informational, not a build failure", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": "export default {};",
    });
    const { logger, stdout, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const { results, failed } = await runTasksIsolated(ctx, ["css", "js"], { announceEmpty: true });

    assert.equal(failed, false);
    assert.deepEqual(results, []);
    assert.match(stdout(), /⊘ Build: .*no assets declared/);
    assert.equal(stderr(), "");
});

test("a config with entries does not claim there is nothing to do", async () => {
    const root = await vanillaProject();
    const { logger, stdout } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["css", "js"]);

    assert.doesNotMatch(stdout(), /nothing|no assets declared/);
});

test("the isolated runner builds JavaScript even when CSS fails", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        // Omitting `server` must still provide defaults with a parsed proxy URL.
        "ektokit.config.mjs": `export default {
            assets: {
                css: { processor: "vanilla", entries: [{ input: "css/style.css", output: "built/style.css" }] },
                js: { entries: [{ input: "js/global.js", output: "built/global.js" }] },
            },
        };`,
        "assets/css/style.css": ".broken {\n",
        "assets/js/global.js": 'console.log("fine");\n',
    });

    const { logger, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    const { failed } = await runTasksIsolated(ctx, ["css", "js"], { announceEmpty: true });

    assert.equal(failed, true);
    assert.match(stderr(), /CSS build failed: assets\/css\/style\.css:1/);

    // A CSS failure must not prevent independent JavaScript entries from building.
    assert.match(await read(path.join(root, "assets/built/global.js")), /"fine"/);

    // And the config parses into something `dev` can actually serve.
    assert.equal(ctx.config.server.proxyUrl.origin, "http://localhost:2368");
});

test("one broken entry does not stop the entries after it", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "vanilla",
                    entries: [
                        { input: "css/style.css", output: "built/style.css" },
                        { input: "css/cards.css", output: "built/cards.css" },
                        { input: "css/lightbox.css", output: "built/lightbox.css" },
                    ],
                },
                js: {
                    entries: [
                        { input: "js/broken.js", output: "built/broken.js" },
                        { input: "js/after.js", output: "built/after.js" },
                    ],
                },
            },
        };`,
        "assets/css/style.css": ".site { color: red; }\n",
        "assets/css/cards.css": ".card { color: ;\n",
        "assets/css/lightbox.css": ".box { color: blue; }\n",
        "assets/js/broken.js": "function ( {\n",
        "assets/js/after.js": 'console.log("after");\n',
    });

    const { logger, stdout, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    const { failed } = await runTasksIsolated(ctx, ["css", "js"]);

    assert.equal(failed, true);

    // Valid entries on both sides of a failure must still be generated.
    assert.match(await read(path.join(root, "assets/built/style.css")), /\.site/);
    assert.equal(await exists(path.join(root, "assets/built/cards.css")), false);
    assert.match(await read(path.join(root, "assets/built/lightbox.css")), /\.box/);

    // Same rule for JavaScript, where the failure is the first entry.
    assert.equal(await exists(path.join(root, "assets/built/broken.js")), false);
    assert.match(await read(path.join(root, "assets/built/after.js")), /"after"/);

    // Every declared entry gets a line, so the run reads as a whole.
    assert.match(stdout(), /✗ CSS {2}cards\.css/);
    assert.match(stdout(), /✗ JS {3}broken\.js/);
    assert.match(stdout(), /✓ CSS {2}lightbox\.css/);

    // And each failure still gets its readable block, named per task.
    // Both name the source file that failed, on the same rule — not the entry
    // for one and the bundle for the other.
    assert.match(stderr(), /CSS build failed: assets\/css\/cards\.css:1/);
    assert.match(stderr(), /JS build failed: assets\/js\/broken\.js:1/);
});

test("the production runner stops subsequent tasks after an entry fails", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "vanilla",
                    entries: [
                        { input: "css/a.css", output: "built/a.css" },
                        { input: "css/b.css", output: "built/b.css" },
                    ],
                },
                js: { entries: [{ input: "js/c.js", output: "built/c.js" }] },
            },
        };`,
        "assets/css/a.css": ".a { color: red; }\n",
        "assets/css/b.css": ".b { color: ;\n",
        "assets/js/c.js": 'console.log("c");\n',
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    // Per-entry isolation must still report production failure to the caller,
    // preventing the ZIP command from packaging a failed build.
    await assert.rejects(runTasks(ctx, ["css", "js"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /CSS build failed: assets\/css\/b\.css:1/);
        return true;
    });

    // The JS task never ran, because the command stopped at the CSS one.
    assert.equal(await exists(path.join(root, "assets/built/c.js")), false);
});

test("a broken partial is reported once, against the partial", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "vanilla",
                    entries: [
                        { input: "css/style.css", output: "built/style.css" },
                        { input: "css/blog.css", output: "built/blog.css" },
                        { input: "css/admin.css", output: "built/admin.css" },
                    ],
                },
            },
        };`,
        "assets/css/style.css": '@import "./parts/tokens.css";\n.site { color: red; }\n',
        "assets/css/blog.css": '@import "./parts/tokens.css";\n.post { color: blue; }\n',
        "assets/css/admin.css": ".admin { color: green; }\n",
        "assets/css/parts/tokens.css": ":root {\n    --gap: ;\n",
    });

    const { logger, stdout, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    await runTasksIsolated(ctx, ["css"]);

    // Two entries import it, so two outputs are missing — that part is per
    // entry, and every declared entry still gets its line.
    assert.match(stdout(), /✗ CSS {2}style\.css/);
    assert.match(stdout(), /✗ CSS {2}blog\.css/);
    assert.match(stdout(), /✓ CSS {2}admin\.css/);

    // But one file is broken, so one error block. Naming the entry would point
    // at `style.css`, which is fine; the file to open is the partial.
    assert.match(stderr(), /CSS build failed: assets\/css\/parts\/tokens\.css:1/);
    assert.equal(stderr().split("CSS build failed").length - 1, 1, "said once, not once per entry");
    assert.equal(stderr().includes("assets/css/style.css"), false, "the healthy entry is not blamed");
});
