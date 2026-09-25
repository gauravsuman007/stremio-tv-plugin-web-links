import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHost = {
    requestVpnCapability: async () => ({ configured: false }),
    vpnBadge: () => "",
    vpnSheet: () => "",
    render: {
        escape: (v) => String(v),
        page: (opts) => opts.body,
        chrome: () => ""
    }
};

function tmpDataDir() {
    return mkdtempSync(join(tmpdir(), "web-links-test-"));
}

test("plugin factory returns a StremioTvPlugin shape", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    try {
        const plugin = createPlugin(fakeHost, dir);
        assert.equal(plugin.id, "web-links");
        assert.equal(typeof plugin.name, "string");
        assert.equal(typeof plugin.routes, "function");
        assert.equal(typeof plugin.extraStreamsFor, "function");
        assert.deepEqual(plugin.settingsLink, { label: "Web Links", href: "/plugin/web-links" });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("extraStreamsFor returns no streams with no scrapers dropped in", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    try {
        const plugin = createPlugin(fakeHost, dir);
        const streams = await plugin.extraStreamsFor("movie", "tt0000000");
        assert.deepEqual(streams, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the settings route renders without a client crash", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    try {
        const plugin = createPlugin(fakeHost, dir);
        const routes = plugin.routes();
        const route = routes.find((r) => r.method === "GET" && r.path === "/plugin/web-links");
        assert.ok(route);

        const fakeClient = { link: (p) => p, session: {} };
        const response = await route.handle({
            method: "GET",
            path: "/plugin/web-links",
            query: new URLSearchParams(),
            form: new URLSearchParams(),
            headers: {},
            client: fakeClient,
            params: {}
        });
        assert.ok(response.body.includes("Web Links"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
