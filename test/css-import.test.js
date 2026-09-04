import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createContext, runTasks } from "../src/context.js";
import { makeLogger, makeProject, read } from "./helpers.js";

const config = `export default {
    assets: {
        css: {
            processor: "vanilla",
            entries: [{ input: "css/style.css", output: "built/style.css" }],
        },
    },
};
`;

/**
 * @param {Record<string, string>} files
 */
async function project(files) {
    return makeProject({
        "package.json": '{ "name": "theme", "type": "module" }',
        "ektokit.config.mjs": config,
        ...files,
    });
}

/**
 * @param {string} root
 * @param {"development" | "production"} mode
 */
async function build(root, mode = "production") {
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode, logger });

    await runTasks(ctx, ["css"]);

    return read(path.join(root, "assets/built/style.css"));
}

// These cases cover vanilla CSS: postcss-import resolves imports and
// Lightning CSS minifies production output. Tailwind uses its own pipeline.

test("inlines local imports, recursively and in order", async () => {
    const root = await project({
        "assets/css/style.css":
            '@import "./lib/reset.css";\n@import "./lib/deep/typo.css";\n\n.hero { color: red; }\n',
        "assets/css/lib/reset.css": "* { margin: 0; }\n",
        "assets/css/lib/deep/typo.css": '@import "./nested.css";\nbody { font: 16px; }\n',
        "assets/css/lib/deep/nested.css": ".nested { color: rebeccapurple; }\n",
    });

    const css = await build(root, "development");

    assert.ok(!css.includes('@import "./'), "no local import survives");
    assert.ok(css.includes("* { margin: 0; }"));
    assert.ok(css.includes(".nested { color: rebeccapurple; }"));
    assert.ok(css.includes("body { font: 16px; }"));
    assert.ok(
        css.indexOf("margin: 0") < css.indexOf(".nested") &&
            css.indexOf(".nested") < css.indexOf("body { font") &&
            css.indexOf("body { font") < css.indexOf(".hero"),
        "declaration order follows the import order",
    );
});

test("keeps a remote import in place", async () => {
    const root = await project({
        "assets/css/style.css": '@import "./lib/fonts.css";\n.hero { color: red; }\n',
        "assets/css/lib/fonts.css":
            '@import url("https://fonts.googleapis.com/css2?family=Inter");\nbody { font-family: Inter; }\n',
    });

    const css = await build(root, "development");
    const lines = css.trim().split("\n");

    assert.match(lines[0], /^@import url\("https:\/\/fonts\.googleapis\.com/, "remote import kept first");
    assert.ok(css.includes("body { font-family: Inter; }"));
});

test("vanilla preserves url() from an imported file without rebasing it", async () => {
    const root = await project({
        "assets/css/style.css":
            '@import "./lib/vendor/logo.css";\n.hero { background: url("../images/hero.png"); }\n',
        "assets/css/lib/vendor/logo.css": '.logo { background: url("../../../images/logo.svg"); }\n',
    });

    const css = await build(root, "development");

    // postcss-import preserves url() values. Authors must write paths relative
    // to the final stylesheet's location.
    assert.ok(
        css.includes('url("../../../images/logo.svg")'),
        "the imported url() is left untouched, not rebased",
    );
    assert.ok(css.includes('url("../images/hero.png")'));
});

test("leaves absolute, remote and data url() alone", async () => {
    const root = await project({
        "assets/css/style.css": '@import "./lib/a.css";\n',
        "assets/css/lib/a.css":
            '.a { background: url("/assets/images/a.png"); }\n' +
            '.b { background: url("https://cdn.example.com/b.png"); }\n' +
            '.c { background: url("data:image/gif;base64,R0lGOD"); }\n' +
            '.d { fill: url("#gradient"); }\n',
    });

    const css = await build(root, "development");

    assert.ok(css.includes('url("/assets/images/a.png")'));
    assert.ok(css.includes('url("https://cdn.example.com/b.png")'));
    assert.ok(css.includes('url("data:image/gif;base64,R0lGOD")'));
    assert.ok(css.includes('url("#gradient")'));
});

test("resolves an import from node_modules", async () => {
    const root = await project({
        "assets/css/style.css": '@import "a-vendor-package/reset.css";\n.hero { color: red; }\n',
        "node_modules/a-vendor-package/reset.css": "* { margin: 0; }\n",
    });

    const css = await build(root, "development");

    assert.ok(css.includes("* { margin: 0; }"), "postcss-import resolves package imports itself");
});

test("dedupes an import of the same file", async () => {
    const root = await project({
        "assets/css/style.css":
            '@import "./lib/reset.css";\n@import "./lib/reset.css";\n.hero { color: red; }\n',
        "assets/css/lib/reset.css": "* { margin: 0; }\n",
    });

    const css = await build(root, "development");
    const occurrences = css.split("margin: 0").length - 1;

    // postcss-import's default `skipDuplicates` dedupes by resolved file
    // path within the same scope.
    assert.equal(occurrences, 1, "the same file is only inlined once");
});

test("a missing import stops the build and names the file", async () => {
    const root = await project({
        "assets/css/style.css": '@import "./lib/gone.css";\n',
        "assets/built/style.css": ".previous { color: red; }\n",
    });

    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["css"]), (error) => {
        assert.equal(error.name, "EktoKitError");
        assert.match(error.detail, /Failed to find '\.\/lib\/gone\.css'/);
        // The file and line moved into the headline, where the name is the
        // file that failed rather than the entry being built.
        assert.match(error.message, /style\.css:1/);
        return true;
    });

    assert.equal(
        await read(path.join(root, "assets/built/style.css")),
        ".previous { color: red; }\n",
        "a failed build leaves the previous output in place",
    );
});

test("a circular import resolves quietly to empty, rather than erroring", async () => {
    // postcss-import resolves this import-only cycle to empty output without
    // reporting an error. EktoKit does not add separate cycle detection.
    const root = await project({
        "assets/css/style.css": '@import "./lib/a.css";\n',
        "assets/css/lib/a.css": '@import "./b.css";\n',
        "assets/css/lib/b.css": '@import "./a.css";\n',
    });

    const css = await build(root, "development");

    assert.equal(css.trim(), "", "the cycle resolves to empty output instead of failing the build");
});

test("wraps a conditional import in the at-rules postcss-import produces", async () => {
    // postcss-import controls nesting and formatting. This combination emits
    // @media around @supports; EktoKit does not reorder those conditions.
    const root = await project({
        "assets/css/style.css":
            '@import "./lib/a.css" print;\n' +
            '@import "./lib/a.css" layer(base);\n' +
            '@import "./lib/a.css" layer;\n' +
            '@import "./lib/a.css" supports((display: grid)) screen and (min-width: 40em);\n',
        "assets/css/lib/a.css": ".a { color: black; }\n",
    });

    const css = await build(root, "development");
    const collapsed = css.replace(/\s+/g, " ");

    assert.match(collapsed, /@media print \{ ?\.a/, "a media query wraps the rules");
    assert.match(collapsed, /@layer base \{ ?\.a/, "layer(...) becomes @layer");
    assert.match(collapsed, /@layer \{ ?\.a/, "a bare layer becomes an anonymous @layer");
    assert.match(
        collapsed,
        /@media screen and \(min-width: 40em\) \{ ?@supports/,
        "supports and media both wrap the rules",
    );
});

test("minifies vanilla CSS in production", async () => {
    const root = await project({
        "assets/css/style.css": ".hero {\n    color:   red;\n    margin: 0px 0px;\n}\n",
    });

    const css = await build(root, "production");

    assert.equal(css.trim(), ".hero{color:red;margin:0}");
});

test("does not minify vanilla CSS in development", async () => {
    const root = await project({
        "assets/css/style.css": ".hero {\n    color: red;\n}\n",
    });

    const css = await build(root, "development");

    assert.ok(css.includes("\n"), "the formatted input survives unminified");
    assert.ok(css.includes("    color: red;"));
});

test("the search-path list is trimmed, and only that shape", async () => {
    const root = await project({
        "assets/css/style.css": '@import "./gone.css";\n',
    });
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["css"]), (error) => {
        // The name of what could not be found stays.
        assert.match(error.detail, /Failed to find '\.\/gone\.css'/);

        // The directories it searched do not: one place could have been
        // searched, and the headline already names the file that searched it.
        assert.equal(error.detail.includes("in ["), false, "the path list is gone");
        assert.equal(error.detail.includes(root), false, "no absolute path leaks in");
        assert.equal(error.detail.trim(), error.detail, "and nothing dangles after the trim");
        return true;
    });
});

test("a syntax error keeps its complete reason without a search-path suffix", async () => {
    const root = await project({
        "assets/css/style.css": ".a {\n    color: red;\n",
    });
    const { logger } = makeLogger();
    const ctx = await createContext({ root, mode: "production", logger });

    await assert.rejects(runTasks(ctx, ["css"]), (error) => {
        assert.equal(error.detail, "Unclosed block");
        return true;
    });
});

test("the trim touches the search-path shape and nothing else", async () => {
    const { trimSearchPaths } = await import("../src/builders/css.js");

    // What postcss-import actually produces, with one directory and with more.
    assert.equal(
        trimSearchPaths("Failed to find './a.css'\n  in [\n    /theme/assets/css\n  ]"),
        "Failed to find './a.css'",
    );
    assert.equal(
        trimSearchPaths("Failed to find './a.css'\n  in [\n    /one\n    /two\n  ]"),
        "Failed to find './a.css'",
    );

    // Everything else is somebody else's message and is left alone: a single
    // line, a multi-line reason that is not the list, and text that merely
    // mentions the words without being the shape.
    for (const untouched of [
        "Unclosed block",
        "Unexpected }\nsecond line of detail",
        "Failed to find './a.css'\n  in [\n    /theme\n  ] and then more text",
        "in [ /inline ]",
        "",
    ]) {
        assert.equal(trimSearchPaths(untouched), untouched, JSON.stringify(untouched));
    }
});
