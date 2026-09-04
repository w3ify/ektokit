import path from "node:path";

import chokidar from "chokidar";
import picomatch from "picomatch";

import { pathKey } from "../config.js";
import { runTasksIsolated } from "../context.js";

const DEBOUNCE_MS = 75;

const ALWAYS_IGNORED = new Set(["node_modules", ".git", ".temp"]);

/**
 * Labels used in `18:42:08 HBS changed: partials/header.hbs`.
 * @param {string} file
 */
function changeLabel(file) {
    switch (path.extname(file)) {
        case ".hbs":
            return "HBS";
        case ".js":
            return "JS";
        case ".css":
            return "CSS";
        default:
            return "File";
    }
}

/**
 * @param {string} file
 */
function isStylesheet(file) {
    return path.extname(file).toLowerCase() === ".css";
}

/**
 * @param {string} file
 */
function toPosix(file) {
    return file.split(path.sep).join("/");
}

/**
 * chokidar v4 no longer accepts glob patterns, so the static prefix of each
 * pattern is watched and the glob itself is applied as a matching layer.
 *
 * @param {string[]} patterns
 * @param {string} root
 */
function watchTargets(patterns, root) {
    const bases = new Set();

    for (const pattern of patterns) {
        const { base } = picomatch.scan(pattern);
        bases.add(path.resolve(root, base || "."));
    }

    // Drop any base already covered by a parent base.
    const sorted = [...bases].sort((a, b) => a.length - b.length);

    return sorted.filter(
        (candidate, index) =>
            !sorted.slice(0, index).some((parent) => {
                const relative = path.relative(parent, candidate);
                return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
            }),
    );
}

/**
 * The watch patterns and task routing are not configurable or derived from
 * entries: a Ghost theme has `assets/` for its stylesheets and scripts and loads
 * `.hbs` from the theme root down, so the shape is already fixed. After a JS
 * match, the config only narrows which declared entries that task rebuilds.
 *
 * With Tailwind, templates and scripts are scanned for class names, so a change
 * to either has to rebuild the CSS. With vanilla CSS there is nothing to scan,
 * so a template change only reloads the browser.
 *
 * @param {import("../config.js").EktoKitConfig} config
 */
export function watchRules(config) {
    const tailwind = config.css.processor === "tailwind";

    return [
        { files: ["assets/**/*.css"], run: ["css"] },
        { files: ["assets/**/*.js"], run: tailwind ? ["css", "js"] : ["js"] },
        // A Ghost theme keeps its templates at the root and every other
        // template under `partials/`, at any depth. An empty `run` means:
        // reload, but there is nothing to rebuild.
        { files: ["*.hbs", "partials/**/*.hbs"], run: tailwind ? ["css"] : [] },
    ];
}

/**
 * Watches the theme and rebuilds what a saved file affects.
 *
 * Saves are debounced, builds never overlap, and a failed build logs the error
 * without killing the watcher — the next save recovers.
 *
 * @param {import("../context.js").Context} ctx
 * @param {{ onReload?: () => void }} [options]
 */
export function createWatcher(ctx, { onReload } = {}) {
    const { root, config, logger } = ctx;

    const ruleSet = watchRules(config);

    const rules = ruleSet.map((rule) => ({
        run: rule.run,
        isMatch: picomatch(rule.files, { dot: true }),
    }));

    const generated = new Set([
        ...config.css.entries.map((entry) => entry.outputPath),
        ...config.js.entries.map((entry) => entry.outputPath),
    ]);

    /**
     * One input may feed more than one output. Index it once so each save can
     * select every affected entry without scanning or rebuilding unrelated
     * bundles.
     * @type {Map<string, typeof config.js.entries>}
     */
    const jsEntriesByInput = new Map();

    for (const entry of config.js.entries) {
        for (const inputPath of entry.inputPaths) {
            const key = pathKey(inputPath);
            const entries = jsEntriesByInput.get(key) ?? [];

            if (!entries.includes(entry)) entries.push(entry);
            jsEntriesByInput.set(key, entries);
        }
    }

    // An ordered list, not a set: tasks run in the order their rule declares
    // them, and a task already queued keeps its first position.
    /** @type {Array<"css" | "js">} */
    const pending = [];
    /** @type {Set<(typeof config.js.entries)[number]>} */
    const pendingJsEntries = new Set();
    /** @type {Set<(typeof config.css.entries)[number]>} */
    const pendingCssEntries = new Set();
    let pendingReload = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let running = false;

    /** @type {import("chokidar").FSWatcher | null} */
    let watcher = null;

    /**
     * @param {string} absolute
     */
    function isIgnored(absolute) {
        if (generated.has(absolute)) return true;

        const relative = path.relative(root, absolute);

        if (relative === "") return false;
        if (relative.startsWith("..")) return true;

        const segments = relative.split(path.sep);

        if (segments.some((segment) => ALWAYS_IGNORED.has(segment))) return true;

        return pathKey(path.resolve(root, segments[0])) === pathKey(config.zip.outputPath);
    }

    /**
     * @param {string} absolute
     */
    function tasksFor(absolute) {
        const relative = toPosix(path.relative(root, absolute));
        /** @type {Array<"css" | "js">} */
        const tasks = [];
        let matched = false;

        for (const rule of rules) {
            if (!rule.isMatch(relative)) continue;

            matched = true;

            for (const task of rule.run) {
                if (!tasks.includes(task)) tasks.push(task);
            }
        }

        return { relative, tasks, matched };
    }

    async function flush() {
        if (running || (pending.length === 0 && !pendingReload)) return;

        running = true;

        // Takes the queue and clears it in one step, preserving order.
        const tasks = pending.splice(0);
        const cssEntries = config.css.entries.filter((entry) => pendingCssEntries.has(entry));
        const jsEntries = config.js.entries.filter((entry) => pendingJsEntries.has(entry));
        pendingCssEntries.clear();
        pendingJsEntries.clear();

        const shouldReload = pendingReload;
        pendingReload = false;

        try {
            // The same runner `dev` uses for its initial build, so a save and a
            // startup report an identical error for an identical mistake.
            const { failed } = await runTasksIsolated(ctx, tasks, { cssEntries, jsEntries });

            // Reload only after a successful run. Failed entries keep their
            // previous outputs; successful entries may already be updated.
            if (failed) logger.watching();
            else if (shouldReload) onReload?.();
        } finally {
            running = false;

            // A change that arrived mid-build re-runs the affected tasks once.
            if (pending.length > 0 || pendingReload) void flush();
        }
    }

    /**
     * @param {string} absolute
     */
    function onChange(absolute) {
        if (isIgnored(absolute)) return;

        const { relative, tasks, matched } = tasksFor(absolute);

        if (!matched) return;

        logger.change(changeLabel(relative), relative);

        for (const task of tasks) {
            if (task === "js") {
                const entries = jsEntriesByInput.get(pathKey(absolute)) ?? [];

                // The file can still affect Tailwind and always causes a
                // browser reload, but no JS output reads an undeclared input.
                if (entries.length === 0) continue;
                for (const entry of entries) pendingJsEntries.add(entry);
            }

            if (task === "css") {
                // Only the CSS builder knows what each entry read through
                // `@import`, and only a template or script under Tailwind
                // affects an entry without being part of one. A stylesheet no
                // entry reads still reloads the browser — Ghost may serve it
                // directly — but rebuilds nothing.
                const entries = isStylesheet(absolute)
                    ? ctx.cssEntriesFor(absolute)
                    : config.css.entries;

                if (entries.length === 0) continue;
                for (const entry of entries) pendingCssEntries.add(entry);
            }

            if (!pending.includes(task)) pending.push(task);
        }

        pendingReload = true;

        // Editors emit several events per save; collapse them into one run.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void flush();
        }, DEBOUNCE_MS);
    }

    return {
        async start() {
            const patterns = ruleSet.flatMap((rule) => rule.files);

            watcher = chokidar.watch(watchTargets(patterns, root), {
                ignoreInitial: true,
                ignored: (target) => isIgnored(path.resolve(target)),
            });

            watcher.on("add", onChange);
            watcher.on("change", onChange);
            watcher.on("unlink", onChange);
            watcher.on("error", (error) => logger.failure("Watcher error", error));

            await new Promise((resolve) => watcher.once("ready", resolve));
        },

        async close() {
            if (timer) clearTimeout(timer);
            await watcher?.close();
            watcher = null;
        },

        /** Test hook: resolves once no build is queued or running. */
        async idle() {
            while (timer || running || pending.length > 0 || pendingReload) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        },
    };
}
