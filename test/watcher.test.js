import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createContext, runTasksIsolated } from "../src/context.js";
import { createWatcher } from "../src/watcher/watcher.js";
import { makeLogger, makeProject, read } from "./helpers.js";

const config = `export default {
    assets: {
        css: {
            processor: "vanilla",
            entries: [{ input: "css/style.css", output: "built/style.css" }],
        },
        js: {
            entries: [{ input: "js/global.js", output: "built/global.js" }],
        },
    },
};
`;

async function watchProject() {
    return makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": config,
        "assets/css/style.css": ".a { color: red; }\n",
        "assets/js/global.js": 'console.log("a");\n',
        "index.hbs": "<main></main>\n",
        "partials/header.hbs": "<header></header>\n",
    });
}

/**
 * Wraps the context tasks so the test can observe what actually ran.
 * @param {import("../src/context.js").Context} ctx
 */
function trackTasks(ctx) {
    /** @type {string[]} */
    const ran = [];
    const original = { ...ctx.tasks };

    ctx.tasks = {
        css: async (entries) => {
            ran.push("css");
            return original.css(entries);
        },
        js: async (entries) => {
            ran.push("js");
            return original.js(entries);
        },
    };

    return ran;
}

/**
 * @param {() => boolean} condition
 */
async function waitFor(condition, timeout = 5000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error("Timed out waiting for watcher");
}

test("routes each kind of file to the right tasks", async (t) => {
    const root = await watchProject();
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    await fs.writeFile(path.join(root, "assets/css/style.css"), ".a { color: blue; }\n");
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["css"], "CSS change runs css only");

    ran.length = 0;
    await fs.writeFile(path.join(root, "assets/js/global.js"), 'console.log("b");\n');
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["js"], "vanilla: a script only rebuilds JS");

    ran.length = 0;
    let before = reloads;
    await fs.writeFile(path.join(root, "partials/header.hbs"), "<header>x</header>\n");
    await waitFor(() => reloads > before);
    await watcher.idle();

    assert.deepEqual(ran, [], "vanilla: a template only reloads");

    ran.length = 0;
    before = reloads;
    await fs.writeFile(path.join(root, "index.hbs"), "<main>x</main>\n");
    await waitFor(() => reloads > before);
    await watcher.idle();

    assert.deepEqual(ran, [], "a root-level template is matched too");

    assert.equal(reloads, 4, "one reload per successful run");
    assert.match(await read(path.join(root, "assets/built/global.js")), /console\.log\("b"\)/);
});

for (const kind of ["css", "js"]) {
    test(`development reports missing ${kind.toUpperCase()} inputs and recovers after creation and deletion`, async (t) => {
        const input = `assets/${kind}/missing.${kind}`;
        const output = `assets/built/${kind === "css" ? "style.css" : "global.js"}`;
        const assets = {
            css: { entries: [{ input: kind === "css" ? "css/missing.css" : "css/style.css", output: "built/style.css" }] },
            js: { entries: [{ input: kind === "js" ? ["js/global.js", "js/missing.js"] : "js/global.js", output: "built/global.js" }] },
        };
        const previous = kind === "css" ? ".previous { color: red; }\n" : 'console.log("previous");\n';
        const recovered = kind === "css" ? ".recovered { color: blue; }\n" : 'console.log("recovered");\n';
        const root = await makeProject({
            "package.json": '{ "name": "theme" }',
            "ektokit.config.mjs": `export default ${JSON.stringify({ assets })};`,
            "assets/css/style.css": ".valid { color: red; }\n",
            "assets/js/global.js": 'console.log("valid");\n',
            [output]: previous,
        });
        const { logger, stdout, stderr } = makeLogger();
        const ctx = await createContext({ root, mode: "development", logger });
        const startup = await runTasksIsolated(ctx, ["css", "js"]);

        assert.equal(startup.failed, true);
        assert.equal(startup.results.filter((result) => result.error).length, 1);
        assert.match(stdout(), /not generated/);
        assert.ok(stderr().includes(`input not found: ${input}`));
        assert.equal(await read(path.join(root, output)), previous);
        assert.match(await read(path.join(root, kind === "css" ? "assets/built/global.js" : "assets/built/style.css")), /valid/);
        const startupErrors = stderr();

        let reloads = 0;
        const watcher = createWatcher(ctx, { onReload: () => reloads++ });
        await watcher.start();
        t.after(() => watcher.close());

        await fs.writeFile(path.join(root, input), recovered);
        await waitFor(() => reloads > 0);
        await watcher.idle();

        assert.match(await read(path.join(root, output)), /recovered/);
        assert.equal(reloads, 1);
        assert.equal(stderr(), startupErrors, "creating the input produces no new error");

        const successfulOutput = await read(path.join(root, output));
        await fs.unlink(path.join(root, input));
        await waitFor(() => stderr().length > startupErrors.length);
        await watcher.idle();

        assert.ok(stderr().slice(startupErrors.length).includes(`input not found: ${input}`));
        assert.equal(await read(path.join(root, output)), successfulOutput);
        assert.equal(reloads, 1, "deleting a declared input must not reload the preview");
        assert.match(stdout(), /Watching for changes/);

        const deletionErrors = stderr();
        await fs.writeFile(path.join(root, input), recovered);
        await waitFor(() => reloads === 2);
        await watcher.idle();

        assert.equal(await read(path.join(root, output)), successfulOutput);
        assert.equal(stderr(), deletionErrors, "the watcher recovers without restarting");
    });
}

test("saving a nested JavaScript vendor rebuilds its declared bundle", async (t) => {
    // A nested vendor and the theme's own script both contribute to this bundle.
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "vanilla",
                    entries: [{ input: "css/style.css", output: "built/style.css" }],
                },
                js: {
                    entries: [
                        {
                            input: ["js/lib/photoswipe.min.js", "js/lightbox.js"],
                            output: "built/lightbox.js",
                        },
                    ],
                },
            },
        };`,
        "assets/css/style.css": ".a { color: red; }\n",
        "assets/js/lightbox.js": 'console.log("lightbox");\n',
        "assets/js/lib/photoswipe.min.js": "!function(){}();\n",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    const watcher = createWatcher(ctx, {});

    await watcher.start();
    t.after(() => watcher.close());

    await fs.writeFile(path.join(root, "assets/js/lib/photoswipe.min.js"), "!function(){1}();\n");
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["js"], "a vendor under assets/ rebuilds its bundle");

    ran.length = 0;
    await fs.writeFile(path.join(root, "assets/js/lightbox.js"), 'console.log("x");\n');
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["js"], "so does the theme's own script in the same entry");
    assert.match(await read(path.join(root, "assets/built/lightbox.js")), /console\.log\("x"\)/);
});

test("rebuilds only the JavaScript entries affected by a save", async (t) => {
    const root = await makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": `export default {
            assets: {
                js: {
                    entries: [
                        { input: "js/global.js", output: "built/global.js" },
                        { input: ["js/cards.js", "js/single.js"], output: "built/single.js" },
                        { input: ["js/shared.js", "js/lightbox.js"], output: "built/lightbox.js" },
                        { input: ["js/shared.js", "js/admin.js"], output: "built/admin.js" },
                    ],
                },
            },
        };`,
        "assets/js/global.js": 'console.log("global");\n',
        "assets/js/cards.js": 'console.log("cards");\n',
        "assets/js/single.js": 'console.log("single");\n',
        "assets/js/shared.js": 'console.log("shared");\n',
        "assets/js/lightbox.js": 'console.log("lightbox");\n',
        "assets/js/admin.js": 'console.log("admin");\n',
    });
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const originalJs = ctx.tasks.js;
    /** @type {string[][]} */
    const calls = [];

    ctx.tasks.js = async (entries) => {
        calls.push((entries ?? []).map((entry) => entry.output));
        return originalJs(entries);
    };

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });
    await watcher.start();
    t.after(() => watcher.close());

    await fs.writeFile(path.join(root, "assets/js/single.js"), 'console.log("single-2");\n');
    await waitFor(() => calls.length > 0);
    await watcher.idle();

    assert.deepEqual(calls, [["assets/built/single.js"]], "an array input selects its one bundle");
    assert.equal(
        await read(path.join(root, "assets/built/single.js")),
        'console.log("cards");\n;\nconsole.log("single-2");\n',
        "the whole selected entry is rebuilt in input order",
    );
    await assert.rejects(fs.access(path.join(root, "assets/built/global.js")));
    await assert.rejects(fs.access(path.join(root, "assets/built/lightbox.js")));

    calls.length = 0;
    await fs.writeFile(path.join(root, "assets/js/shared.js"), 'console.log("shared-2");\n');
    await waitFor(() => calls.length > 0);
    await watcher.idle();

    assert.deepEqual(
        calls,
        [["assets/built/lightbox.js", "assets/built/admin.js"]],
        "a shared input rebuilds every affected entry in declaration order",
    );

    calls.length = 0;
    const beforeUnlisted = reloads;
    await fs.writeFile(path.join(root, "assets/js/unlisted.js"), 'console.log("unlisted");\n');
    await waitFor(() => reloads > beforeUnlisted);
    await watcher.idle();

    assert.deepEqual(calls, [], "an undeclared script causes no JavaScript build");

    calls.length = 0;
    await Promise.all([
        fs.writeFile(path.join(root, "assets/js/global.js"), 'console.log("global-2");\n'),
        fs.writeFile(path.join(root, "assets/js/lightbox.js"), 'console.log("lightbox-2");\n'),
    ]);
    await waitFor(() => calls.length > 0);
    await watcher.idle();

    assert.deepEqual(
        calls,
        [["assets/built/global.js", "assets/built/lightbox.js"]],
        "a burst builds the union once in declaration order",
    );
});

test("collapses a burst of saves into a single run", async (t) => {
    const root = await watchProject();
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    const file = path.join(root, "assets/css/style.css");

    for (let i = 0; i < 5; i += 1) {
        await fs.writeFile(file, `.a { color: red; --i: ${i}; }\n`);
    }

    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["css"]);
    assert.equal(reloads, 1);
});

test("keeps watching after a failed build and does not reload", async (t) => {
    const root = await watchProject();
    const { logger, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    const file = path.join(root, "assets/css/style.css");

    await fs.writeFile(file, ".broken {\n");
    await waitFor(() => stderr().includes("CSS build failed"));
    await watcher.idle();

    assert.equal(reloads, 0, "a failed task must not reload");

    await fs.writeFile(file, ".fixed { color: green; }\n");
    await waitFor(() => reloads > 0);
    await watcher.idle();

    assert.equal(reloads, 1, "the watcher recovers on the next save");
    assert.match(await read(path.join(root, "assets/built/style.css")), /\.fixed/);
});

test("a failing task does not cancel the others in the same run", async (t) => {
    const root = await watchProject();
    const { logger, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    // One burst, two tasks: the stylesheet stops parsing while the script is
    // fine. CSS runs first, so a shared catch took the JS build down with it
    // and left the bundle at its previous contents — with nothing said about
    // it, and no recovery until that entry happened to be touched again.
    await fs.writeFile(path.join(root, "assets/css/style.css"), ".broken {\n");
    await fs.writeFile(path.join(root, "assets/js/global.js"), 'console.log("b");\n');

    await waitFor(() => stderr().includes("CSS build failed"));
    await watcher.idle();

    assert.deepEqual(ran, ["css", "js"], "both tasks of the run were attempted");
    assert.match(await read(path.join(root, "assets/built/global.js")), /"b"/);

    // Also proves both tasks shared one run: a second flush carrying only the
    // successful JS would have reloaded.
    assert.equal(reloads, 0, "a run holding a failure still does not reload");
});

test("each failing task names itself, and the run still does not reload", async (t) => {
    const root = await watchProject();
    const { logger, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    await fs.writeFile(path.join(root, "assets/css/style.css"), ".broken {\n");
    await fs.writeFile(path.join(root, "assets/js/global.js"), "const = ;\n");

    await waitFor(() => stderr().includes("JS build failed"));
    await watcher.idle();

    const headlines = stderr()
        .split("\n")
        .filter((line) => line.includes("✗"));

    assert.equal(headlines.length, 2, "one headline per failing task");
    assert.match(headlines[0], /CSS build failed: assets\/css\/style\.css/);
    assert.match(headlines[1], /JS build failed: assets\/js\/global\.js:1/);

    // Each task is named once, not twice: the headline absorbs the message.
    assert.equal(stderr().split("CSS build failed").length - 1, 1);
    assert.equal(reloads, 0);
});

const defaultsConfig = (processor) => `export default {
    assets: {
        css: {
            processor: "${processor}",
            entries: [{ input: "css/style.css", output: "built/style.css" }],
        },
        js: {
            entries: [
                { input: "js/global.js", output: "built/global.js" },
                { input: "js/other.js", output: "built/other.js" },
            ],
        },
    },
};
`;

/**
 * A theme with no `watch` block and files spread across nested folders.
 * @param {"tailwind" | "vanilla"} processor
 */
async function defaultsProject(processor) {
    return makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": defaultsConfig(processor),
        "assets/css/style.css": ".a { color: red; }\n",
        "assets/css/lib/vendor/reset.css": ".r { margin: 0; }\n",
        "assets/js/global.js": 'console.log("a");\n',
        "assets/js/other.js": 'console.log("other");\n',
        "assets/js/lib/deep/cards.js": 'console.log("cards");\n',
        "index.hbs": "<main></main>\n",
        "partials/cards/media/inner.hbs": "<div></div>\n",
        "partials/members/signin.hbs": "<form></form>\n",
        // A Ghost theme never has a template here; it is watched by nobody.
        "stray/orphan.hbs": "<div></div>\n",
    });
}

test("the built-in rules cover nested folders", async (t) => {
    const root = await defaultsProject("vanilla");
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });

    await watcher.start();
    t.after(() => watcher.close());

    /**
     * @param {string} file
     * @param {string} contents
     */
    const save = async (file, contents) => {
        ran.length = 0;
        const before = reloads;
        await fs.writeFile(path.join(root, file), contents);
        await waitFor(() => reloads > before);
        await watcher.idle();
    };

    await save("assets/css/lib/vendor/reset.css", ".r { margin: 1px; }\n");
    assert.deepEqual(ran, ["css"], "CSS at any depth under assets/");

    await save("assets/js/lib/deep/cards.js", 'console.log("b");\n');
    assert.deepEqual(ran, [], "vanilla: an undeclared JS file only reloads");

    await save("partials/cards/media/inner.hbs", "<div>x</div>\n");
    assert.deepEqual(ran, [], "vanilla: a template only reloads");

    await save("partials/members/signin.hbs", "<form>x</form>\n");
    assert.deepEqual(ran, [], "a partial at any depth is watched");

    assert.equal(reloads, 4, "every save reloads the browser");

    // Template watching covers root-level .hbs files and partials/**/*.hbs,
    // not arbitrary directories elsewhere in the theme.
    const before = reloads;
    await fs.writeFile(path.join(root, "stray/orphan.hbs"), "<div>x</div>\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(reloads, before, "a template outside root and partials/ is ignored");
});

test("with tailwind, templates and scripts rebuild the CSS", async (t) => {
    const root = await defaultsProject("tailwind");
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);
    const originalJs = ctx.tasks.js;
    /** @type {string[][]} */
    const jsCalls = [];

    ctx.tasks.js = async (entries) => {
        jsCalls.push((entries ?? []).map((entry) => entry.output));
        return originalJs(entries);
    };

    // The CSS task is stubbed: this asserts routing, not Tailwind itself.
    ctx.tasks.css = async () => {
        ran.push("css");
        return [];
    };

    const watcher = createWatcher(ctx, {});

    await watcher.start();
    t.after(() => watcher.close());

    await fs.writeFile(path.join(root, "index.hbs"), "<main>x</main>\n");
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["css"], "tailwind: a template rescans classes");

    ran.length = 0;
    await fs.writeFile(path.join(root, "assets/js/global.js"), 'console.log("global");\n');
    await waitFor(() => ran.length > 1);
    await watcher.idle();

    assert.deepEqual(ran, ["css", "js"], "tailwind: a declared script rescans classes and rebuilds");
    assert.deepEqual(
        jsCalls,
        [["assets/built/global.js"]],
        "Tailwind rebuilds all CSS but only the affected JS entry",
    );

    ran.length = 0;
    await fs.writeFile(path.join(root, "assets/js/lib/deep/cards.js"), 'console.log("c");\n');
    await waitFor(() => ran.length > 0);
    await watcher.idle();

    assert.deepEqual(ran, ["css"], "tailwind: an undeclared script still rescans classes");
});

test("ignores generated output and node_modules", async (t) => {
    const root = await watchProject();
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });
    const ran = trackTasks(ctx);

    const watcher = createWatcher(ctx, {});

    await watcher.start();
    t.after(() => watcher.close());

    await fs.mkdir(path.join(root, "assets/built"), { recursive: true });
    await fs.writeFile(path.join(root, "assets/built/style.css"), "/* generated */\n");
    await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules/pkg/index.js"), "export default 1;\n");

    await new Promise((resolve) => setTimeout(resolve, 300));
    await watcher.idle();

    assert.deepEqual(ran, []);
});

test("vanilla rebuilds only the CSS entries that read the saved file", async (t) => {
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
        // `base.css` is shared by two entries; `admin.css` stands alone.
        "assets/css/style.css": '@import "./parts/base.css";\n.site { color: red; }\n',
        "assets/css/blog.css": '@import "./parts/base.css";\n.post { color: blue; }\n',
        "assets/css/admin.css": ".admin { color: green; }\n",
        "assets/css/parts/base.css": ":root { --gap: 1rem; }\n",
        "assets/css/parts/orphan.css": ".nobody-imports-me { color: red; }\n",
        "index.hbs": "<main></main>\n",
    });
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    // The graph is a by-product of building, so the first build fills it in.
    await ctx.tasks.css();

    const originalCss = ctx.tasks.css;
    /** @type {string[][]} */
    const calls = [];

    ctx.tasks.css = async (entries) => {
        calls.push((entries ?? ctx.config.css.entries).map((entry) => entry.output));
        return originalCss(entries);
    };

    let reloads = 0;
    const watcher = createWatcher(ctx, { onReload: () => reloads++ });
    await watcher.start();
    t.after(() => watcher.close());

    const save = async (file, contents) => {
        await fs.writeFile(path.join(root, file), contents);
        await watcher.idle();
    };

    await save("assets/css/admin.css", ".admin { color: teal; }\n");
    await waitFor(() => calls.length > 0);
    await watcher.idle();

    assert.deepEqual(calls.at(-1), ["assets/built/admin.css"], "a declared input rebuilds its entry");

    // A partial is not an input of anything, but `postcss-import` reported it
    // as read by the two entries that pull it in — and not by the third.
    await save("assets/css/parts/base.css", ":root { --gap: 2rem; }\n");
    await waitFor(() => calls.length > 1);
    await watcher.idle();

    assert.deepEqual(calls.at(-1), ["assets/built/style.css", "assets/built/blog.css"]);

    // A stylesheet no entry reads rebuilds nothing. It still reloads: Ghost can
    // serve it straight from the theme folder, with no build in between.
    const before = calls.length;
    const reloadsBefore = reloads;

    await save("assets/css/parts/orphan.css", ".nobody-imports-me { color: blue; }\n");
    await waitFor(() => reloads > reloadsBefore);
    await watcher.idle();

    assert.equal(calls.length, before, "no entry reads it, so no entry is rebuilt");
});

test("creating a missing CSS import rebuilds the failed entry", async (t) => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "vanilla",
                    entries: [{ input: "css/style.css", output: "built/style.css" }],
                },
            },
        };`,
        "assets/css/style.css": ".site { color: red; }\n",
        "index.hbs": "<main></main>\n",
    });
    const { logger, stderr } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    await ctx.tasks.css();

    const originalCss = ctx.tasks.css;
    let builds = 0;

    ctx.tasks.css = async (entries) => {
        builds += 1;
        return originalCss(entries);
    };

    const watcher = createWatcher(ctx, { onReload: () => {} });
    await watcher.start();
    t.after(() => watcher.close());

    // Import a partial that does not exist yet. The entry fails, so its graph
    // is dropped — otherwise the file about to be created would match nothing
    // and the theme would never recover without restarting.
    await fs.writeFile(
        path.join(root, "assets/css/style.css"),
        '@import "./parts/new.css";\n.site { color: red; }\n',
    );
    await waitFor(() => stderr().includes("CSS build failed"));
    await watcher.idle();

    const buildsBefore = builds;

    await fs.mkdir(path.join(root, "assets/css/parts"), { recursive: true });
    await fs.writeFile(path.join(root, "assets/css/parts/new.css"), ".new { color: gold; }\n");
    await waitFor(() => builds > buildsBefore);
    await watcher.idle();

    assert.match(await read(path.join(root, "assets/built/style.css")), /\.new/);
});

test("with tailwind every entry is rebuilt, whatever was saved", async (t) => {
    const root = await makeProject({
        "package.json": '{ "name": "theme" }',
        "ektokit.config.mjs": `export default {
            assets: {
                css: {
                    processor: "tailwind",
                    entries: [
                        { input: "css/style.css", output: "built/style.css" },
                        { input: "css/admin.css", output: "built/admin.css" },
                    ],
                },
            },
        };`,
        "assets/css/style.css": ".site { color: red; }\n",
        "assets/css/admin.css": ".admin { color: green; }\n",
        "index.hbs": "<main></main>\n",
    });
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "development", logger });

    // Tailwind is not installed here, and does not need to be: what is under
    // test is which entries the watcher selects, before any of them builds.
    /** @type {string[][]} */
    const calls = [];

    ctx.tasks.css = async (entries) => {
        calls.push((entries ?? ctx.config.css.entries).map((entry) => entry.output));
        return [];
    };

    const watcher = createWatcher(ctx, { onReload: () => {} });
    await watcher.start();
    t.after(() => watcher.close());

    const both = ["assets/built/style.css", "assets/built/admin.css"];

    // Tailwind scans the whole theme for class names, so narrowing by which
    // entry read a file would be wrong: any of them can be affected.
    await fs.writeFile(path.join(root, "assets/css/admin.css"), ".admin { color: teal; }\n");
    await waitFor(() => calls.length > 0);
    await watcher.idle();

    assert.deepEqual(calls.at(-1), both, "a declared input still rebuilds every entry");

    await fs.writeFile(path.join(root, "index.hbs"), '<main class="p-8"></main>\n');
    await waitFor(() => calls.length > 1);
    await watcher.idle();

    assert.deepEqual(calls.at(-1), both, "and so does a template");
});
