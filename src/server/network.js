import os from "node:os";

/**
 * First non-internal IPv4 address, used for the LAN URL when the server is
 * exposed to the network.
 *
 * @returns {string | null} null when only loopback is available
 */
export function localNetworkAddress() {
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const entry of interfaces ?? []) {
            if (entry.family === "IPv4" && !entry.internal) return entry.address;
        }
    }

    return null;
}
