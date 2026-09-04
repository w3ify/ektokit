import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import picomatch from "picomatch";
import yazl from "yazl";

import { CONFIG_PATH, PACKAGE_PATH, normalizeArchiveName, pathKey } from "../config.js";
import { EktoKitError } from "../errors.js";

/**
 * Resolves the archive name: `zip.name`, else the theme's `package.json` name,
 * else an error.
 *
 * @param {import("../context.js").Context} ctx
 * @returns {string} the name, without the `.zip` extension
 */
export function resolveZipName(ctx) {
    const configured = ctx.config.zip.name;

    if (typeof configured === "string" && configured !== "") return configured;

    const fromPackage = ctx.pkg?.name;

    if (typeof fromPackage === "string" && fromPackage.trim() !== "") {
        return normalizeArchiveName('package.json "name"', fromPackage);
    }

    // Ghost requires the name, so its absence is a broken theme rather than a
    // ZIP problem, and the message says which. One message covers the theme
    // with no package.json too: installing the CLI writes one, so that folder
    // was never a theme to begin with.
    throw new EktoKitError('package.json is missing a "name"', {
        detail: "Ghost requires it, and the archive is named after it.",
        hint: `Add "name" to ${PACKAGE_PATH}, or set "zip.name" in ${CONFIG_PATH}.`,
    });
}

/** Directories that never belong in a distributed theme, whatever the config says. */
const ALWAYS_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__MACOSX"]);

/** OS clutter, which really does turn up at any depth. */
const ALWAYS_IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Files that can carry secrets and live at the theme root by convention:
 * `.npmrc` and the `.env` family. Only the root is checked, since nesting them
 * is not a convention worth inventing a rule for.
 *
 * @param {string} name
 */
function isIgnoredRootFile(name) {
    return name === ".npmrc" || name === ".env" || name.startsWith(".env.");
}

/**
 * Collects regular files for the theme archive.
 *
 * Includes dot-files except for built-in exclusions and `zip.ignore` matches.
 * Built-ins cover the output directory, dependency
 * and Git directories, OS clutter, and root-level `.npmrc` and `.env` files
 * (including `.env.*`). Symbolic links are not followed or included.
 *
 * @param {string} root
 * @param {string[]} ignore glob patterns from `zip.ignore`
 * @param {string} outputDir absolute path of the fixed `dist/` directory
 * @returns {Promise<string[]>} paths relative to the theme root, sorted
 */
export async function collectFiles(root, ignore, outputDir) {
    const isIgnored = picomatch(ignore, { dot: true });
    const isIgnoredDir = picomatch(
        ignore.map((pattern) => pattern.replace(/\/\*\*$/, "")),
        { dot: true },
    );

    /** @type {string[]} */
    const files = [];

    /**
     * @param {string} directory
     */
    async function walk(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });

        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute).split(path.sep).join("/");

            // The archive must never contain itself. Path identity follows the
            // rest of the tool and ignores case on every platform.
            if (pathKey(absolute) === pathKey(outputDir)) {
                if (!entry.isDirectory()) {
                    throw new EktoKitError("dist must be a directory dedicated to ZIP archives", {
                        detail: `Found: ${relative}`,
                        hint: "Move it out of dist, then run the command again.",
                    });
                }

                await assertDedicatedOutputDirectory(absolute, root);
                continue;
            }

            if (entry.isDirectory()) {
                if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) continue;
                if (isIgnoredDir(relative) || isIgnored(relative)) continue;

                await walk(absolute);
                continue;
            }

            if (!entry.isFile()) continue;
            if (ALWAYS_IGNORED_FILES.has(entry.name)) continue;
            if (directory === root && isIgnoredRootFile(entry.name)) continue;
            if (isIgnored(relative)) continue;

            files.push(relative);
        }
    }

    await walk(root);

    // Deterministic archive contents.
    return files.sort();
}

/**
 * Refuses to hide theme content behind the built-in `dist/` exclusion. Existing
 * archives and interrupted archive temporaries are the only contents that make
 * sense in this directory.
 *
 * OS clutter is skipped here for the same reason it is skipped everywhere else:
 * opening `dist/` to pick up the archive is what creates it, so treating it as
 * theme content would break the next run over a file the file manager puts back.
 *
 * @param {string} directory actual path and casing found on disk
 * @param {string} root theme root
 */
async function assertDedicatedOutputDirectory(directory, root) {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const lower = entry.name.toLowerCase();

        if (entry.isFile() && ALWAYS_IGNORED_FILES.has(entry.name)) continue;
        if (entry.isFile() && (lower.endsWith(".zip") || lower.endsWith(".zip.tmp"))) continue;

        const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/");

        throw new EktoKitError("dist must be dedicated to ZIP archives", {
            detail: `Found: ${relative}`,
            hint: "Move it out of dist, then run the command again.",
        });
    }
}

/**
 * Writes the theme archive.
 *
 * Writes to a temporary file and replaces the destination only once complete.
 * A failed write preserves the previous archive. Abrupt process termination
 * can leave a temporary file behind.
 *
 * @param {import("../context.js").Context} ctx
 */
export async function createZip(ctx) {
    const started = performance.now();

    const name = resolveZipName(ctx);
    const outputDir = ctx.config.zip.outputPath;
    const target = path.resolve(outputDir, `${name}.zip`);
    const temporary = `${target}.tmp`;

    // Name validation already guarantees this. Keep the boundary at the write
    // site too, so a future naming change cannot make the archive escape dist.
    if (pathKey(path.dirname(target)) !== pathKey(outputDir)) {
        throw new EktoKitError("ZIP target must stay inside dist");
    }

    const files = await collectFiles(ctx.root, ctx.config.zip.ignore, outputDir);

    await fs.mkdir(outputDir, { recursive: true });

    const archive = new yazl.ZipFile();

    for (const file of files) {
        archive.addFile(path.join(ctx.root, file), file);
    }

    archive.end();

    try {
        await pipeline(archive.outputStream, createWriteStream(temporary));
        await fs.rename(temporary, target);
    } catch (cause) {
        await fs.rm(temporary, { force: true });

        throw new EktoKitError("Unable to create ZIP", {
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
        });
    }

    return {
        name: `${name}.zip`,
        path: target,
        files,
        ms: performance.now() - started,
    };
}
