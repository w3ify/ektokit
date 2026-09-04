#!/usr/bin/env node

import { isSupportedNode, unsupportedNodeMessage } from "../src/node-version.js";

// Checked before the CLI is loaded, so an unsupported runtime gets this line
// instead of whatever the first modern thing to load would have said.
if (!isSupportedNode(process.versions.node)) {
    process.stderr.write(unsupportedNodeMessage(process.versions.node));
    process.exit(1);
}

const { run } = await import("../src/cli.js");

await run(process.argv.slice(2));
