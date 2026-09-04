import { isEktoKitError } from "../errors.js";

const supportsColor =
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb" &&
    (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

const paint = (code) => (value) =>
    supportsColor ? `\u001b[${code}m${value}\u001b[0m` : String(value);

const color = {
    green: paint("32"),
    red: paint("31"),
    cyan: paint("36"),
    yellow: paint("33"),
    dim: paint("2"),
};

/**
 * The tool's own name, in bold black on a green field.
 *
 * Set a black foreground explicitly for contrast with the green background.
 *
 * Padding belongs to the colored badge and is omitted from plain-text output.
 *
 * @param {string} value
 */
const badge = (value) => (supportsColor ? paint("42;1;30")(` ${value} `) : value);

/** Widest task label is `ZIP`, plus a gap. */
const TASK_LABEL_WIDTH = 5;

/** Widest address label is `Network:`, plus a gap. */
const ROW_LABEL_WIDTH = 10;

const NAME_WIDTH = 26;

/**
 * Sets the address block apart from the task lines above it, the way a quote
 * is set apart from body text.
 */
const RULE = "┃";

const pad = (value, width) => String(value).padEnd(width);

/**
 * Formats a duration the same way for every task line.
 * @param {number} ms
 */
function duration(ms) {
    const rounded = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
    return String(rounded).padStart(6);
}

/**
 * Terminal output for the CLI.
 *
 * Timestamps are switched on while watching, so the order of events during a
 * long session stays readable.
 */
export class Logger {
    constructor({ timestamps = false, stream = process.stdout, errorStream = process.stderr } = {}) {
        this.timestamps = timestamps;
        this.stream = stream;
        this.errorStream = errorStream;
    }

    /** @param {boolean} value */
    setTimestamps(value) {
        this.timestamps = value;
    }

    #time() {
        if (!this.timestamps) return "";

        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");

        return `${color.dim(`${hh}:${mm}:${ss}`)} `;
    }

    /** @param {string} [line] */
    write(line = "") {
        this.stream.write(`${line}\n`);
    }

    /** @param {string} [line] */
    writeError(line = "") {
        this.errorStream.write(`${line}\n`);
    }

    /** @param {string} version */
    banner(version) {
        this.write();
        this.write(`${badge("EktoKit")} ${color.green(`v${version}`)}`);
        this.write();
    }

    /**
     * `✓ CSS  style.css                 84ms`
     * @param {string} label
     * @param {string} name
     * @param {number} ms
     */
    task(label, name, ms) {
        this.write(
            `${this.#time()}${color.green("✓")} ${pad(label, TASK_LABEL_WIDTH)}${pad(name, NAME_WIDTH)}${color.dim(duration(ms))}`,
        );
    }

    /**
     * One entry that did not build, on the same grid as the ones that did.
     *
     * Reports the outcome of this attempt, not whether a previous output
     * exists on disk. The caller prints error details after the entry lines.
     *
     * @param {string} label
     * @param {string} name
     * @param {string} reason
     */
    entryFailed(label, name, reason) {
        this.write(
            `${this.#time()}${color.red("✗")} ${pad(label, TASK_LABEL_WIDTH)}${pad(name, NAME_WIDTH)}${color.dim(reason)}`,
        );
    }

    /**
     * `⊘ Build: no assets declared in ektokit.config.mjs`
     *
     * A whole command that found nothing to do. No columns — there is no file
     * to name. A run that says nothing looks like a run that worked.
     *
     * @param {string} label
     * @param {string} reason
     */
    nothing(label, reason) {
        this.write(`${this.#time()}${color.yellow("⊘")} ${label}: ${color.dim(reason)}`);
    }

    /**
     * @param {string} type
     * @param {string} file
     */
    change(type, file) {
        this.write(`${this.#time()}${color.dim(`${type} changed:`)} ${file}`);
    }

    reload() {
        this.write(`${this.#time()}${color.cyan("↻")} Reload`);
    }

    /**
     * One row of the address block, behind the rule.
     *
     * @param {string} label
     * @param {string} value already styled by the caller
     */
    #row(label, value) {
        this.write(`${color.dim(RULE)} ${pad(`${label}:`, ROW_LABEL_WIDTH)}${value}`);
    }

    /**
     * `┃ Local:       http://localhost:3000`
     *
     * The address is the point of the line, and the one thing on screen someone
     * will copy, so it is what carries the color.
     *
     * @param {string} label
     * @param {string} value
     */
    url(label, value) {
        this.#row(label, color.cyan(value));
    }

    /**
     * The same row for a value that is a note rather than an address. Muted, so
     * a row that holds no address does not compete with the ones that do.
     *
     * @param {string} label
     * @param {string} value
     */
    info(label, value) {
        this.#row(label, color.dim(value));
    }

    /**
     * What the run produced, at the end of it. Green: the addresses are cyan
     * because they are read, this one is green because it is the outcome.
     *
     * @param {string} message
     */
    summary(message) {
        this.write(color.green(message));
    }

    /** @param {string} message */
    note(message) {
        this.write(color.dim(message));
    }

    /**
     * Something worth knowing that is not a failure: development continues.
     *
     * @param {string} message
     */
    warn(message) {
        this.write(`${this.#time()}${color.yellow("!")} ${message}`);
    }

    /**
     * The line that says the process is alive and idle. Spacing is the
     * caller's call: it follows a blank line at startup and an error block
     * after a failed build.
     */
    watching() {
        this.write(color.green("Watching for changes..."));
    }

    /**
     * Renders an expected failure without a stack trace.
     * Unexpected errors keep their stack so real bugs stay debuggable.
     *
     * @param {string} headline
     * @param {unknown} error
     */
    failure(headline, error) {
        // A caller that already names what failed would have the message
        // repeat it one line down — `CSS build failed` over `CSS build failed:
        // assets/css/style.css`. The longer one wins the headline, and nothing
        // is said twice. A message that says something else is left alone.
        const restates =
            isEktoKitError(error) &&
            (error.message === headline || error.message.startsWith(`${headline}:`));

        this.writeError(`${this.#time()}${color.red("✗")} ${restates ? error.message : headline}`);

        /** Blocks below the headline, each separated by one blank line. */
        const sections = [];

        if (isEktoKitError(error)) {
            if (!restates) sections.push(error.message);
            if (error.detail) sections.push(error.detail);
            if (error.hint) sections.push(color.dim(error.hint));
        } else if (error instanceof Error) {
            sections.push(error.stack ?? error.message);
        } else {
            sections.push(String(error));
        }

        for (const section of sections) {
            this.writeError();
            this.writeError(section);
        }

        this.writeError();
    }
}

export { color };
