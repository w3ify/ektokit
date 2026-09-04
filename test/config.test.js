import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig, validateConfig } from "../src/config.js";
import { createContext, runTasks } from "../src/context.js";
import { makeLogger, makeProject } from "./helpers.js";

const base =
    'export default { assets: { css: { processor: "vanilla", entries: [] } } };\n';

test("reports a missing config in a readable way", async () => {
    const root = await makeProject({ "package.json": '{ "name": "plain" }' });

    await assert.rejects(loadConfig(root), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.message, /No ektokit\.config\.mjs found/);
        return true;
    });
});

// The config is `.mjs`, which is an ES module whatever the package.json says,
// so a theme runs the CLI exactly as Ghost ships it.

test("loads the config from a plain Ghost theme", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "plain" }',
        "ektokit.config.mjs": "export default { server: { port: 4000 } };",
    });

    const { config, file } = await loadConfig(root);

    assert.equal(file.endsWith("ektokit.config.mjs"), true);
    assert.equal(/** @type {any} */ (config).server.port, 4000);
});

test("reports a config without a default export", async () => {
    const root = await makeProject({ "package.json": '{ "type": "module" }', "ektokit.config.mjs": "export const config = {};\n" });

    await assert.rejects(loadConfig(root), (error) => {
        assert.match(error.message, /no default export/);
        return true;
    });
});

test("reports a config that does not export an object", async () => {
    const root = await makeProject({ "package.json": '{ "type": "module" }', "ektokit.config.mjs": "export default [];\n" });

    await assert.rejects(loadConfig(root), (error) => {
        assert.match(error.message, /must export an object/);
        return true;
    });
});

test("resolves every assets path against the theme's assets/ directory", async () => {
    const root = await makeProject({ "package.json": '{ "type": "module" }', "ektokit.config.mjs": base });
    const config = validateConfig(
        {
            assets: {
                css: { processor: "vanilla", entries: [{ input: "a.css", output: "built/a.css" }] },
                js: { entries: [{ input: "a.js", output: "built/a.js" }] },
            },
        },
        { root },
    );

    // The config writes the short path; the resolved one always lands in assets/.
    assert.equal(config.css.entries[0].inputPath, path.join(root, "assets", "a.css"));
    assert.equal(config.css.entries[0].outputPath, path.join(root, "assets", "built", "a.css"));
    assert.equal(config.js.entries[0].outputPath, path.join(root, "assets", "built", "a.js"));
});

test("reports assets paths from the theme root, so the terminal stays pasteable", () => {
    const config = validateConfig(
        {
            assets: {
                css: { entries: [{ input: "css/style.css", output: "built/style.css" }] },
                js: { entries: [{ input: ["js/a.js", "js/b.js"], output: "built/out.js" }] },
            },
        },
        { root: "/theme" },
    );

    // What an input error line prints is the full path from the theme
    // root, never the shorter spelling the config uses.
    assert.equal(config.css.entries[0].input, "assets/css/style.css");
    assert.equal(config.css.entries[0].output, "assets/built/style.css");
    assert.deepEqual(config.js.entries[0].inputs, ["assets/js/a.js", "assets/js/b.js"]);
    assert.equal(config.js.entries[0].output, "assets/built/out.js");
});

test("refuses an assets path that still carries the assets/ prefix", () => {
    // Paths are relative to assets/, so repeating the prefix would resolve
    // to assets/assets/ instead of the intended input.
    assert.throws(
        () =>
            validateConfig(
                { assets: { css: { entries: [{ input: "assets/css/a.css", output: "built/a.css" }] } } },
                { root: "/theme" },
            ),
        (error) => {
            assert.match(error.message, /must not start with "assets\/"/);
            assert.match(error.hint, /Write "css\/a\.css" instead/);
            return true;
        },
    );
});

test("refuses a path that resolves back inside assets/ by a detour", () => {
    // `../assets/css/a.css` and `js/../css/a.css` both land on the same file as
    // `css/a.css`. Accepting them would give one file several valid spellings,
    // which is the kind of implicit behaviour this config does not have.
    for (const written of ["../assets/css/a.css", "css/../css/a.css", "css//a.css"]) {
        assert.throws(
            () =>
                validateConfig(
                    { assets: { css: { entries: [{ input: written, output: "built/a.css" }] } } },
                    { root: "/theme" },
                ),
            (error) => {
                assert.match(error.message, /must be a plain path relative to assets\//);
                assert.match(error.hint, /It resolves to "css\/a\.css"/);
                return true;
            },
            `expected "${written}" to be refused`,
        );
    }
});

test("accepts a leading ./, which is a no-op prefix", () => {
    // Unlike `../` or `a/../b`, "./" does not restructure the path — it is
    // syntax noise, normalized the same way whitespace around the value is.
    const config = validateConfig(
        { assets: { css: { entries: [{ input: "./css/a.css", output: "./built/a.css" }] } } },
        { root: "/theme" },
    );

    assert.equal(config.css.entries[0].input, "assets/css/a.css");
    assert.equal(config.css.entries[0].output, "assets/built/a.css");
});

test("refuses a file whose extension the pipeline does not build", () => {
    // The CSS pipeline runs PostCSS over .css; the JS one concatenates .js.
    // Nothing else is built, so a wrong extension is caught here rather than
    // failing later — and it makes a .js output colliding with a .css input
    // structurally impossible.
    for (const [section, entry, expected] of [
        ["css", { input: "css/a.scss", output: "built/a.css" }, /CSS input "css\/a\.scss" must be a \.css file/],
        ["css", { input: "css/a.css", output: "built/a.js" }, /CSS output "built\/a\.js" must be a \.css file/],
        ["js", { input: "js/a.css", output: "built/a.js" }, /JS input "js\/a\.css" must be a \.js file/],
    ]) {
        assert.throws(
            () => validateConfig({ assets: { [section]: { entries: [entry] } } }, { root: "/theme" }),
            expected,
        );
    }

    // A pre-minified vendor still ends in .js, and the check ignores case.
    const config = validateConfig(
        {
            assets: {
                js: { entries: [{ input: "js/lib/photoswipe.min.js", output: "built/a.js" }] },
                css: { entries: [{ input: "css/A.CSS", output: "built/a.css" }] },
            },
        },
        { root: "/theme" },
    );

    assert.deepEqual(config.js.entries[0].inputs, ["assets/js/lib/photoswipe.min.js"]);
    assert.equal(config.css.entries[0].input, "assets/css/A.CSS");
});

test("a plain path at any depth is accepted unchanged", () => {
    const config = validateConfig(
        { assets: { js: { entries: [{ input: "js/lib/deep/cards.js", output: "built/a.js" }] } } },
        { root: "/theme" },
    );

    assert.deepEqual(config.js.entries[0].inputs, ["assets/js/lib/deep/cards.js"]);
});

test("refuses an output that is also an input", () => {
    // An input/output collision would overwrite the source file during a build.
    assert.throws(
        () =>
            validateConfig(
                { assets: { css: { entries: [{ input: "style.css", output: "style.css" }] } } },
                { root: "/theme" },
            ),
        (error) => {
            assert.match(error.message, /CSS output "style\.css" is also an input/);
            assert.match(error.hint, /"built\/style\.css"/);
            return true;
        },
    );
});

test("the output/input collision is checked without case", () => {
    // "a.css" and "A.css" are the same file on Windows and macOS. Refused on
    // every platform, so a config never destroys a source only somewhere else.
    assert.throws(
        () =>
            validateConfig(
                { assets: { css: { entries: [{ input: "a.css", output: "A.css" }] } } },
                { root: "/theme" },
            ),
        /output "A\.css" is also an input/,
    );
});

test("the output/input collision is checked across entries", () => {
    // Two CSS entries, where one writes what the other reads.
    assert.throws(
        () =>
            validateConfig(
                {
                    assets: {
                        css: {
                            entries: [
                                { input: "built/base.css", output: "built/final.css" },
                                { input: "css/a.css", output: "built/base.css" },
                            ],
                        },
                    },
                },
                { root: "/theme" },
            ),
        /CSS output "built\/base\.css" is also an input/,
    );
});

test("refuses the same output declared twice", () => {
    // The second entry would overwrite the first, and the terminal would print
    // two successful lines for one surviving file.
    assert.throws(
        () =>
            validateConfig(
                {
                    assets: {
                        css: {
                            entries: [
                                { input: "css/a.css", output: "built/style.css" },
                                { input: "css/b.css", output: "./built/style.css" },
                            ],
                        },
                    },
                },
                { root: "/theme" },
            ),
        (error) => {
            assert.match(error.message, /CSS output "built\/style\.css" is already declared/);
            assert.match(error.hint, /Rename it, or move it to another folder/);
            return true;
        },
    );

    // Same file on a case-insensitive file system, so refused everywhere.
    assert.throws(
        () =>
            validateConfig(
                {
                    assets: {
                        js: {
                            entries: [
                                { input: "js/a.js", output: "built/out.js" },
                                { input: "js/b.js", output: "built/Out.js" },
                            ],
                        },
                    },
                },
                { root: "/theme" },
            ),
        /is already declared/,
    );
});

test("outputs at different levels are different files", () => {
    const config = validateConfig(
        {
            assets: {
                css: {
                    entries: [
                        { input: "css/a.css", output: "a.css" },
                        { input: "css/b.css", output: "built/a.css" },
                    ],
                },
            },
        },
        { root: "/theme" },
    );

    assert.equal(config.css.entries[0].output, "assets/a.css");
    assert.equal(config.css.entries[1].output, "assets/built/a.css");
});

test("the same input may feed more than one output", () => {
    // A shared utility belongs in two bundles; only outputs must be unique.
    const config = validateConfig(
        {
            assets: {
                js: {
                    entries: [
                        { input: ["js/util.js", "js/a.js"], output: "built/one.js" },
                        { input: ["js/util.js", "js/b.js"], output: "built/two.js" },
                    ],
                },
            },
        },
        { root: "/theme" },
    );

    assert.equal(config.js.entries[0].inputs[0], "assets/js/util.js");
    assert.equal(config.js.entries[1].inputs[0], "assets/js/util.js");
});

test("the same file name in a different folder is not a collision", () => {
    const config = validateConfig(
        {
            assets: {
                js: { entries: [{ input: "js/global.js", output: "built/global.js" }] },
            },
        },
        { root: "/theme" },
    );

    assert.equal(config.js.entries[0].output, "assets/built/global.js");
});

test("refuses the bare word assets, with or without slashes", () => {
    for (const written of ["assets", "assets/", "//assets/css/a.css"]) {
        assert.throws(
            () =>
                validateConfig(
                    { assets: { css: { entries: [{ input: written, output: "built/a.css" }] } } },
                    { root: "/theme" },
                ),
            /must not start with "assets\//,
            `expected "${written}" to be refused`,
        );
    }

    // A hidden file or folder that merely *contains* the word is not a prefix.
    const config = validateConfig(
        { assets: { css: { entries: [{ input: ".assets/a.css", output: "built/a.css" }] } } },
        { root: "/theme" },
    );

    assert.equal(config.css.entries[0].input, "assets/.assets/a.css");
});

test("refuses spaces at the edge of a path segment, keeps them inside", () => {
    for (const written of ["css /a.css", "css/ a.css"]) {
        assert.throws(
            () =>
                validateConfig(
                    { assets: { css: { entries: [{ input: written, output: "built/a.css" }] } } },
                    { root: "/theme" },
                ),
            /has a space at the edge of a path segment/,
            `expected ${JSON.stringify(written)} to be refused`,
        );
    }

    // A space inside a segment is a legal filename everywhere.
    const config = validateConfig(
        { assets: { css: { entries: [{ input: "css/my file.css", output: "built/a.css" }] } } },
        { root: "/theme" },
    );

    assert.equal(config.css.entries[0].input, "assets/css/my file.css");
});

test("trims whitespace around the value, which is editing noise", () => {
    // Space at the *edge of a segment* is still refused (see above); space
    // around the whole value is formatting, the way any config is read.
    const config = validateConfig(
        { assets: { css: { entries: [{ input: "  css/a.css  ", output: "built/a.css" }] } } },
        { root: "/theme" },
    );

    assert.equal(config.css.entries[0].input, "assets/css/a.css");
});

test("refuses a trailing slash, which names a folder", () => {
    assert.throws(
        () =>
            validateConfig(
                { assets: { css: { entries: [{ input: "css/a.css/", output: "built/a.css" }] } } },
                { root: "/theme" },
            ),
        (error) => {
            assert.match(error.message, /CSS input "css\/a\.css\/" must be a file, not a directory/);
            assert.match(error.hint, /trailing slash names a folder/);
            return true;
        },
    );
});

test("refuses a path that resolves to the assets directory itself", () => {
    assert.throws(
        () =>
            validateConfig(
                { assets: { css: { entries: [{ input: "css/..", output: "built/a.css" }] } } },
                { root: "/theme" },
            ),
        /must be a \.css file/,
    );
});

test("refuses an assets path that escapes assets/", () => {
    assert.throws(
        () =>
            validateConfig(
                {
                    assets: {
                        js: { entries: [{ input: "../node_modules/x/a.js", output: "built/a.js" }] },
                    },
                },
                { root: "/theme" },
            ),
        /must be inside the theme's assets\/ directory/,
    );
});

test("rejects an assets block that is not an object", () => {
    assert.throws(() => validateConfig({ assets: [] }, { root: "/theme" }), /assets must be an object/);
});

test("marks array inputs as concatenated and keeps their order", () => {
    const config = validateConfig(
        {
            assets: {
                js: {
                    entries: [
                        { input: ["b.js", "a.js"], output: "built/out.js" },
                        { input: "single.js", output: "built/single.js" },
                    ],
                },
            },
        },
        { root: "/theme" },
    );

    assert.equal(config.js.entries[0].concat, true);
    assert.deepEqual(config.js.entries[0].inputs, ["assets/b.js", "assets/a.js"]);
    assert.equal(config.js.entries[1].concat, false);
    assert.deepEqual(config.js.entries[1].inputs, ["assets/single.js"]);
});

test("applies server defaults and validates the port", () => {
    const config = validateConfig({}, { root: "/theme" });

    assert.deepEqual(Object.keys(config).sort(), ["css", "js", "root", "server", "zip"]);
    assert.equal(config.server.proxy, "http://localhost:2368");
    assert.equal(config.server.port, 3000);
    assert.equal(config.server.host, false);

    // The proxy needs a parsed URL even when the server block is omitted.
    assert.equal(config.server.proxyUrl?.origin, "http://localhost:2368");
    assert.deepEqual(
        validateConfig({ server: {} }, { root: "/theme" }).server,
        config.server,
        "an absent block and an empty one normalize the same way",
    );

    assert.throws(() => validateConfig({ server: { port: 0 } }, { root: "/theme" }), /port/);
    assert.throws(() => validateConfig({ server: { port: 3000.5 } }, { root: "/theme" }), /port/);
    assert.throws(() => validateConfig({ server: { proxy: "nope" } }, { root: "/theme" }), /valid URL/);
    assert.throws(() => validateConfig({ server: { host: "yes" } }, { root: "/theme" }), /boolean/);
});

test("rejects an unknown CSS processor", () => {
    assert.throws(
        () => validateConfig({ assets: { css: { processor: "sass", entries: [] } } }, { root: "/theme" }),
        /assets\.css\.processor must be one of/,
    );
});

test("rejects incomplete entries", () => {
    assert.throws(
        () => validateConfig({ assets: { css: { entries: [{ input: "a.css" }] } } }, { root: "/theme" }),
        /CSS output in entry 1/,
    );

    assert.throws(
        () => validateConfig({ assets: { js: { entries: [{ input: [], output: "a.js" }] } } }, { root: "/theme" }),
        /at least one input file/,
    );
});

test("fixes the ZIP output directory at dist and keeps zip.name optional", () => {
    const config = validateConfig({ zip: { output: "somewhere-else" } }, { root: "/theme" });

    assert.equal(config.zip.outputPath, path.resolve("/theme", "dist"));
    assert.equal("output" in config.zip, false);
    assert.equal(config.zip.name, undefined);
    assert.deepEqual(config.zip.ignore, []);
});

test("normalizes a portable ZIP name", () => {
    for (const name of ["theme", "theme-pro", "theme_2", "theme.preview"]) {
        assert.equal(validateConfig({ zip: { name: `  ${name}  ` } }, { root: "/theme" }).zip.name, name);
    }
});

test("the ZIP name is a file stem, not a path", () => {
    for (const name of ["../outside", "a/b", "a\\b", "C:\\temp"]) {
        assert.throws(
            () => validateConfig({ zip: { name } }, { root: "/theme" }),
            /zip\.name must be a file name, not a path/,
            name,
        );
    }
});

test("the ZIP name refuses non-portable file names and the extension", () => {
    for (const name of [".", "..", "a?b", "theme.", 'a"b', "CON", "LPT1.txt"]) {
        assert.throws(
            () => validateConfig({ zip: { name } }, { root: "/theme" }),
            /zip\.name is not a valid portable file name/,
            name,
        );
    }

    assert.throws(
        () => validateConfig({ zip: { name: "theme.zip" } }, { root: "/theme" }),
        /zip\.name must not include the \.zip extension/,
    );

    assert.throws(
        () => validateConfig({ zip: { name: "" } }, { root: "/theme" }),
        /zip\.name must be a non-empty string/,
    );
});

test("messages name the config file", async () => {
    const root = await makeProject({
        "package.json": '{ "name": "plain" }',
        "ektokit.config.mjs": "export default { server: { proxy: \"http://localhost:2368\" } };",
    });

    const { logger, stdout } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await runTasks(ctx, ["css", "js"]);

    // `./` so the terminal recognises it as a path and offers to open it —
    // the same way an asset error is already clickable.
    assert.match(stdout(), /no assets declared in \.\/ektokit\.config\.mjs/);
});

test("every invalid ZIP name explains the portable stem", () => {
    for (const name of ["a/b", "..", "a?b", "theme.zip"]) {
        assert.throws(
            () => validateConfig({ zip: { name } }, { root: "/theme" }),
            (error) => {
                assert.match(error.hint, /without a path or the \.zip extension/, name);
                return true;
            },
        );
    }
});
