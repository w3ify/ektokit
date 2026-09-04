import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import { Logger } from "../src/logger/logger.js";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const binPath = path.join(packageRoot, "bin", "ektokit.js");

const temporaryBase = path.resolve(process.env.EKTOKIT_TEST_TMPDIR ?? os.tmpdir());
const projects = new Set();

after(async () => {
    for (const root of projects) {
        if (path.dirname(root) !== temporaryBase || !path.basename(root).startsWith("ektokit-test-")) {
            throw new Error(`Refusing to remove an unexpected test directory: ${root}`);
        }
        await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    projects.clear();
});

/**
 * Creates a throwaway project directory from a `{ relativePath: contents }` map.
 *
 * @param {Record<string, string>} files
 */
export async function makeProject(files) {
    await fs.mkdir(temporaryBase, { recursive: true });
    const root = await fs.mkdtemp(path.join(temporaryBase, "ektokit-test-"));
    projects.add(root);

    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, "utf8");
    }

    return root;
}

/**
 * A logger that captures output instead of writing to the terminal.
 */
export function makeLogger() {
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];

    const logger = new Logger({
        stream: { write: (chunk) => out.push(chunk) },
        errorStream: { write: (chunk) => err.push(chunk) },
    });

    return {
        logger,
        stdout: () => out.join(""),
        stderr: () => err.join(""),
    };
}

/**
 * @param {string} file
 */
export async function read(file) {
    return fs.readFile(file, "utf8");
}

/**
 * @param {string} file
 */
export async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}
