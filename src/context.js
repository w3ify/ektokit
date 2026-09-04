import { CONFIG_PATH, loadConfig, loadPackageJson, validateConfig } from "./config.js";
import { createCssBuilder } from "./builders/css.js";
import { createJavaScriptBuilder } from "./builders/javascript.js";

/**
 * Result of one asset entry: a duration on success or an error on failure.
 *
 * @typedef {{ label: string, name: string } & (
 *   { ms: number, error?: never } | { error: unknown, ms?: never }
 * )} TaskResult
 */

/**
 * @typedef {object} Context
 * @property {string} root
 * @property {"development" | "production"} mode
 * @property {import("./logger/logger.js").Logger} logger
 * @property {import("./config.js").EktoKitConfig} config
 * @property {any} pkg
 * @property {{
 *   css: (entries?: import("./config.js").EktoKitConfig["css"]["entries"]) => Promise<TaskResult[]>,
 *   js: (entries?: import("./config.js").EktoKitConfig["js"]["entries"]) => Promise<TaskResult[]>,
 * }} tasks
 * @property {(file: string) => import("./config.js").EktoKitConfig["css"]["entries"]} cssEntriesFor
 */

/**
 * Loads and validates everything a command needs before doing any work.
 *
 * @param {{ root: string, mode: "development" | "production", logger: import("./logger/logger.js").Logger }} options
 * @returns {Promise<Context>}
 */
export async function createContext({ root, mode, logger }) {
    // Tailwind and PostCSS read NODE_ENV, so it is set before they load.
    process.env.NODE_ENV = mode;

    const { config: raw } = await loadConfig(root);
    const config = validateConfig(raw, { root });
    const pkg = await loadPackageJson(root);

    /** @type {Context} */
    const ctx = { root, mode, logger, config, pkg, tasks: /** @type {any} */ (null) };

    const css = createCssBuilder(ctx);
    const js = createJavaScriptBuilder(ctx);

    ctx.tasks = {
        css: (entries) => css.build(entries),
        js: (entries) => js.build(entries),
    };

    // The watcher asks which entries a saved stylesheet belongs to. The answer
    // comes from the CSS builder, because only a finished build knows what an
    // entry actually read through `@import`.
    ctx.cssEntriesFor = (file) => css.entriesFor(file);

    return ctx;
}

/**
 * Renders one task result, whether it succeeded or failed.
 *
 * @param {import("./logger/logger.js").Logger} logger
 * @param {TaskResult} result
 */
export function logResult(logger, result) {
    if (/** @type {any} */ (result).error) {
        logger.entryFailed(result.label, result.name, "not generated");
        return;
    }

    logger.task(result.label, result.name, result.ms);
}

/**
 * The results of a run that carry an error, in declaration order.
 *
 * @param {TaskResult[]} results
 */
function failuresIn(results) {
    return results.map((result) => /** @type {any} */ (result).error).filter(Boolean);
}

/**
 * Runs the named tasks in order and logs each result.
 *
 * Sequential, not parallel: it keeps terminal output deterministic and makes
 * "reload only after every task succeeded" a plain `await`.
 *
 * @param {Context} ctx
 * @param {Array<"css" | "js">} names
 * @returns {Promise<TaskResult[]>}
 */
export async function runTasks(ctx, names) {
    /** @type {TaskResult[]} */
    const results = [];

    for (const name of names) {
        const taskResults = await ctx.tasks[name]();

        for (const result of taskResults) {
            logResult(ctx.logger, result);
        }

        results.push(...taskResults);

        // The builders report a failed entry instead of throwing, so the
        // commands raise it here: `build` and `zip` stop at the first one, and
        // a failed build never becomes a ZIP.
        const [failure] = failuresIn(taskResults);

        if (failure) {
            // The entry lines above are a block of their own, and the error the
            // CLI prints starts after a blank line — the same shape `dev` has.
            if (taskResults.length > 0) ctx.logger.write();

            throw failure;
        }
    }

    // Distinguish a config with no assets from a build that generated files.
    // The watcher uses a separate runner, so this appears once per command.
    if (results.length === 0) {
        ctx.logger.nothing("Build", `no assets declared in ${CONFIG_PATH}`);
    }

    return results;
}

/**
 * Runs the named tasks in order, letting each one fail on its own.
 *
 * CSS and JavaScript build independently, so a failure in one task must not
 * prevent valid entries in the other from being generated.
 *
 * Used by `dev` at startup and for watcher rebuilds. Asset errors are reported
 * without stopping the development session. `build` and `zip` use
 * {@link runTasks}, which throws after a task reports a failure.
 *
 * @param {Context} ctx
 * @param {Array<"css" | "js">} names
 * @param {{
 *   cssEntries?: import("./config.js").EktoKitConfig["css"]["entries"],
 *   jsEntries?: import("./config.js").EktoKitConfig["js"]["entries"],
 *   announceEmpty?: boolean,
 * }} [options] `cssEntries` and `jsEntries` narrow each task to the entries a
 * save affected; `announceEmpty` says so when a config declares no assets,
 * which belongs to a command's startup and not to every save.
 * @returns {Promise<{ results: TaskResult[], failed: boolean }>}
 */
export async function runTasksIsolated(
    ctx,
    names,
    { cssEntries, jsEntries, announceEmpty = false } = {},
) {
    /** @type {TaskResult[]} */
    const results = [];
    let failed = false;

    for (const name of names) {
        const label = name === "js" ? "JS" : "CSS";

        try {
            const narrowed = name === "js" ? jsEntries : cssEntries;
            const taskResults =
                narrowed !== undefined ? await ctx.tasks[name](narrowed) : await ctx.tasks[name]();

            // Report every attempted entry before the task's error details.
            for (const result of taskResults) {
                logResult(ctx.logger, result);
            }

            results.push(...taskResults);

            const errors = failuresIn(taskResults);

            // The entry lines above are a block of their own; the readable
            // errors start after a blank line.
            if (errors.length > 0 && taskResults.length > 0) ctx.logger.write();
            if (errors.length > 0) failed = true;

            // Deduplicate identical messages and details within this task.
            // Several entries can fail because they import the same file.
            const printed = new Set();

            for (const error of errors) {
                const key = `${error.message}\n${error.detail ?? ""}`;

                if (printed.has(key)) continue;

                printed.add(key);
                ctx.logger.failure(`${label} build failed`, error);
            }
        } catch (error) {
            // Also isolate task-level exceptions that bypass entry results.
            failed = true;

            ctx.logger.failure(`${label} build failed`, error);
        }
    }

    if (announceEmpty && !failed && results.length === 0) {
        ctx.logger.nothing("Build", `no assets declared in ${CONFIG_PATH}`);
    }

    return { results, failed };
}
