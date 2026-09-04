import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import ts from "typescript";
import * as runtime from "@w3ify/ektokit";
import { packageRoot } from "./helpers.js";

function checkConsumer(extension, source) {
    const file = path.join(packageRoot, "test", `type-consumer.${extension}`);
    const options = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        allowJs: true,
        checkJs: true,
        types: [],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);

    // Keep consumer examples in memory; resolve the package through its exports.
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
        path.resolve(name) === file
            ? ts.createSourceFile(name, source, languageVersion, true)
            : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);

    const program = ts.createProgram([file], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, host));
    return program;
}

test("public runtime exports are usable from TypeScript", () => {
    checkConsumer("mts", `
        import { run, EktoKitError, isEktoKitError } from "@w3ify/ektokit";
        import type { EktoKitConfig } from "@w3ify/ektokit";

        const config: EktoKitConfig = { server: { port: 3000 } };
        const result: Promise<void> = run(["build"]);
        const error = new EktoKitError("Failed", {
            detail: "theme.hbs", hint: "Check the file", cause: new Error("Cause"),
        });
        const base: Error = error;
        const detail: string | undefined = error.detail;
        const hint: string | undefined = error.hint;
        const cause: unknown = error.cause;
        new EktoKitError("Without options");
        new EktoKitError("With empty options", {});
        new EktoKitError("Unknown cause", { cause: 42 });

        function inspect(value: unknown) {
            const matches: boolean = isEktoKitError(value);
            if (isEktoKitError(value)) {
                const narrowed: EktoKitError = value;
                const guidance: string | undefined = value.hint;
            } else {
                // @ts-expect-error An unrecognized value is still unknown.
                value.hint;
            }
        }

        // @ts-expect-error Arguments must be an array.
        run("build");
        // @ts-expect-error Every argument must be a string.
        run([123]);
        // @ts-expect-error The argument array is required.
        run();
        // @ts-expect-error There is no returned server handle.
        const handle: { stop(): void } = await run(["dev"]);
        // @ts-expect-error The message is required.
        new EktoKitError();
        // @ts-expect-error The message must be a string.
        new EktoKitError(123);
        // @ts-expect-error Guidance must be plain text.
        new EktoKitError("Failed", { hint: 123 });
        // @ts-expect-error Details must be plain text.
        new EktoKitError("Failed", { detail: false });
        // @ts-expect-error Details may be undefined.
        const requiredDetail: string = error.detail;
        // @ts-expect-error Config types remain checked.
        const invalidConfig: EktoKitConfig = { server: { port: "3000" } };
    `);
});

test("public runtime exports are usable from checked JavaScript", () => {
    checkConsumer("mjs", `
        // @ts-check
        import { run, EktoKitError, isEktoKitError } from "@w3ify/ektokit";

        /** @type {Promise<void>} */
        const result = run(["build"]);
        const error = new EktoKitError("Failed", { hint: "Check the config" });
        /** @type {unknown} */
        const value = error;
        if (isEktoKitError(value)) {
            /** @type {string | undefined} */
            const hint = value.hint;
            value.message.toUpperCase();
        }

        // @ts-expect-error Arguments must be an array in JavaScript too.
        run("build");
        // @ts-expect-error Error options are checked in JavaScript too.
        new EktoKitError("Failed", { detail: 123 });
    `);
});

test("runtime exports have matching declarations and hover documentation", () => {
    const program = checkConsumer("mts", 'import * as kit from "@w3ify/ektokit";');
    const checker = program.getTypeChecker();
    const declarations = program.getSourceFile(path.join(packageRoot, "types", "index.d.ts"));
    assert.ok(declarations, "The package must resolve to its public declaration file");
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(declarations));
    const values = exports.filter((symbol) => symbol.flags & ts.SymbolFlags.Value);

    assert.deepEqual(values.map((symbol) => symbol.name).sort(), Object.keys(runtime).sort());
    for (const symbol of values) {
        assert.ok(ts.displayPartsToString(symbol.getDocumentationComment(checker)), symbol.name);
    }

    const errorClass = values.find((symbol) => symbol.name === "EktoKitError");
    const errorType = checker.getDeclaredTypeOfSymbol(errorClass);
    for (const name of ["detail", "hint"]) {
        const property = errorType.getProperty(name);
        assert.ok(ts.displayPartsToString(property.getDocumentationComment(checker)), name);
    }
});
