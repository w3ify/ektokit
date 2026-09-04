import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { localNetworkAddress } from "../src/server/network.js";

function interfacesFor(t, interfaces) {
    const original = os.networkInterfaces;
    os.networkInterfaces = () => interfaces;
    t.after(() => { os.networkInterfaces = original; });
}

test("network discovery selects the first non-internal IPv4 address", (t) => {
    interfacesFor(t, {
        loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        ethernet: [
            { family: "IPv6", internal: false, address: "2001:db8::1" },
            { family: "IPv4", internal: false, address: "192.0.2.10" },
        ],
        wifi: [{ family: "IPv4", internal: false, address: "192.0.2.20" }],
    });
    assert.equal(localNetworkAddress(), "192.0.2.10");
});

test("network discovery returns null without an external IPv4 address", (t) => {
    interfacesFor(t, {
        loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
        ethernet: [{ family: "IPv6", internal: false, address: "2001:db8::1" }],
        unavailable: undefined,
    });
    assert.equal(localNetworkAddress(), null);
});
