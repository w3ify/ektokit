import assert from "node:assert/strict";
import test from "node:test";

const ESC = "";

/** Collects what the logger writes, in place of a terminal. */
function capture() {
    /** @type {string[]} */
    const lines = [];

    return {
        lines,
        stream: {
            /** @param {string} chunk */
            write: (chunk) => lines.push(String(chunk).replace(/\n$/, "")),
        },
    };
}

/**
 * Whether color is on is decided once, when the module is first evaluated, so
 * each variant is imported under its own URL to get a fresh evaluation.
 *
 * @param {boolean} colored
 */
async function loadLogger(colored) {
    const previous = {
        force: process.env.FORCE_COLOR,
        none: process.env.NO_COLOR,
        term: process.env.TERM,
    };

    if (colored) {
        process.env.FORCE_COLOR = "1";
        delete process.env.NO_COLOR;
        // The test runner may inherit TERM=dumb from a log-capturing shell.
        // Set every input used by color detection instead of depending on the
        // environment that launched the suite.
        process.env.TERM = "xterm-256color";
    } else {
        process.env.NO_COLOR = "1";
        delete process.env.FORCE_COLOR;
    }

    try {
        const module = await import(`../src/logger/logger.js?colored=${colored}`);
        return module.Logger;
    } finally {
        if (previous.force === undefined) delete process.env.FORCE_COLOR;
        else process.env.FORCE_COLOR = previous.force;

        if (previous.none === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previous.none;

        if (previous.term === undefined) delete process.env.TERM;
        else process.env.TERM = previous.term;
    }
}

test("the banner is a name badge and a green version", async () => {
    const Logger = await loadLogger(true);
    const { lines, stream } = capture();

    new Logger({ stream }).banner("1.0.0");

    const banner = lines.find((line) => line.includes("EktoKit"));

    assert.ok(banner, "the banner names the tool");
    assert.ok(banner.includes(`${ESC}[42;1;30m EktoKit ${ESC}[0m`), "bold black on a green field");
    assert.ok(banner.includes(`${ESC}[32mv1.0.0${ESC}[0m`), "the version is green");
});

test("without color the banner is plain text, with no stray leading space", async () => {
    const Logger = await loadLogger(false);
    const { lines, stream } = capture();

    new Logger({ stream }).banner("1.0.0");

    // The padding exists to make the colored field readable; in a plain log or
    // a CI transcript it would only indent the line.
    assert.ok(lines.includes("EktoKit v1.0.0"), "no escape codes and no padding");
});

test("an address row is cyan; a row without an address is muted", async () => {
    const Logger = await loadLogger(true);
    const { lines, stream } = capture();
    const logger = new Logger({ stream });

    logger.url("Local", "http://localhost:3000");
    logger.info("Network", "use --host to expose");

    assert.ok(lines[0].includes(`${ESC}[36mhttp://localhost:3000${ESC}[0m`), "the address is cyan");
    assert.ok(lines[1].includes(`${ESC}[2muse --host to expose${ESC}[0m`), "the note is muted");

    // Every row of the block hangs off the same rule, and the label between
    // rule and value stays uncolored.
    for (const line of lines) {
        assert.ok(line.startsWith(`${ESC}[2m┃${ESC}[0m `), "the row opens with a dim rule");
    }

    assert.match(lines[0], /┃\[0m Local: {4}\[36m/, "the label is plain, and padded");
});

test("the watching line is green, and brings no blank line of its own", async () => {
    const Logger = await loadLogger(true);
    const { lines, stream } = capture();

    new Logger({ stream }).watching();

    // Spacing belongs to the caller: this line follows a blank line at startup
    // and an error block after a failed build.
    assert.deepEqual(lines, [`${ESC}[32mWatching for changes...${ESC}[0m`]);
});

test("a failure headline is not restated by the message below it", async () => {
    const Logger = await loadLogger(false);
    const { EktoKitError } = await import("../src/errors.js");

    const render = (headline, error) => {
        const { lines, stream } = capture();
        new Logger({ errorStream: stream }).failure(headline, error);
        return lines;
    };

    // The watcher names the task, and the builder's message opens with the
    // same words. The longer line wins, and the file is not lost.
    assert.deepEqual(
        render(
            "CSS build failed",
            new EktoKitError("CSS build failed: assets/css/style.css", {
                detail: "Unclosed block\nassets/css/style.css:1",
            }),
        ),
        ["✗ CSS build failed: assets/css/style.css", "", "Unclosed block\nassets/css/style.css:1", ""],
    );

    // A message that says something else is untouched: dropping it here would
    // throw away the only line explaining what went wrong.
    assert.deepEqual(
        render(
            "CSS build failed",
            new EktoKitError("Tailwind processor is enabled, but the dependencies were not found.", {
                detail: "Missing: tailwindcss",
            }),
        ),
        [
            "✗ CSS build failed",
            "",
            "Tailwind processor is enabled, but the dependencies were not found.",
            "",
            "Missing: tailwindcss",
            "",
        ],
    );

    // The commands keep their generic headline, so nothing changes for them.
    assert.deepEqual(
        render("build failed", new EktoKitError("CSS build failed: assets/css/style.css")),
        ["✗ build failed", "", "CSS build failed: assets/css/style.css", ""],
    );
});
