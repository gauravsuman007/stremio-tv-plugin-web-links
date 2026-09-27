import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("extraStreamsFor lists measured links tallest first, unmeasured after in scraper order", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    const pkg = join(dir, "scrapers", "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "scraper.json"), JSON.stringify({ id: "pkg", entry: "e.cjs", version: "1.0.0" }));
    writeFileSync(
        join(pkg, "e.cjs"),
        `const mk=(id,rows)=>({id,name:id,search:async()=>rows.map((height,i)=>({url:"https://x/"+id+i,quality:id+i,...(height?{height}:{})}))});` +
            `module.exports={default:[mk("a",[0,720]),mk("b",[1080]),mk("c",[0])]};`
    );
    try {
        const plugin = createPlugin(fakeHost, dir);
        const streams = await plugin.extraStreamsFor("movie", "tt0000000");
        assert.deepEqual(streams.map((s) => s.value.name), ["b0", "a1", "a0", "c0"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a finished search is reused; a placeholder answer is searched again", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    const pkg = join(dir, "scrapers", "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "scraper.json"), JSON.stringify({ id: "pkg", entry: "e.cjs", version: "1.0.0" }));
    writeFileSync(
        join(pkg, "e.cjs"),
        `globalThis.__calls={done:0,late:0};` +
            `module.exports={default:[` +
            `{id:"done",name:"Done",search:async()=>{__calls.done++;return [{url:"",resolveId:"d",quality:"1080p",height:1080}]}},` +
            `{id:"late",name:"Late",search:async()=>{__calls.late++;if(__calls.late>1)await new Promise(r=>setTimeout(r,3000));return [{url:"",resolveId:"l"}]}}]};`
    );
    try {
        const plugin = createPlugin(fakeHost, dir);
        await plugin.extraStreamsFor("movie", "tt7");
        const started = Date.now();
        const again = await plugin.extraStreamsFor("movie", "tt7");
        assert.ok(Date.now() - started < 1500, "a pending answer is not waited out again");
        assert.equal(again.length, 2);
        assert.deepEqual(globalThis.__calls, { done: 1, late: 2 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("streamColumn draws web links tallest first with the host's play links", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    try {
        const plugin = createPlugin(fakeHost, dir);
        const row = (name, height) => ({
            href: `/play/movie/tt1/${name}`,
            from: { manifest: { id: "web-links", name: `${name} · 1080p` } },
            stream: { title: `Film (2020) · ${name}`, ...(height ? { behaviorHints: { webLinkHeight: height } } : {}) }
        });
        const column = plugin.streamColumn({ type: "movie", id: "tt1", title: "Film", rows: [row("A", 0), row("B", 720), row("C", 1080)], vpn: null, vpnAction: "/vpn", back: "/detail" });
        assert.equal(column.heading, "Web links");
        const hrefs = [...column.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(hrefs, ["/play/movie/tt1/C", "/play/movie/tt1/B", "/play/movie/tt1/A"]);
        assert.ok(column.html.includes(">1080p<"));
        assert.ok(!column.html.includes("Film (2020) · C"), "the site name is dropped from the title");
        assert.ok(column.html.includes("Audio: not stated"));
        const headed = plugin.streamColumn({
            type: "movie", id: "tt1", title: "Film", vpn: null, vpnAction: "", back: "",
            rows: [{ href: "/p", from: { manifest: { id: "web-links", name: "7Movies · up to 1080p · 2586x1080 · Orion" } },
                     stream: { title: "Film (2020) · 7Movies", behaviorHints: { webLinkSite: "7Movies", webLinkServer: "Orion · French", webLinkHeight: 1080, webLinkAudio: ["French"] } } }]
        });
        assert.ok(headed.html.includes("<b>7Movies · Orion · French</b>"), "the row is headed by site and server, in bold");
        assert.ok(!headed.html.includes("up to 1080p") && !headed.html.includes("2586x1080"), "no clutter in the heading");
        assert.ok(headed.html.includes("Audio: French"));
        assert.equal(plugin.streamColumn({ type: "movie", id: "tt1", title: "Film", rows: [], vpn: null, vpnAction: "", back: "" }), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the search timeout defaults to 5s, is shown on the settings page, and is saved", async () => {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = tmpDataDir();
    try {
        const routes = createPlugin(fakeHost, dir).routes();
        const call = (method, path, form = "") =>
            routes.find((r) => r.method === method && r.path === path).handle({
                method, path, query: new URLSearchParams(), form: new URLSearchParams(form), headers: {}, client: { link: (p) => p, session: {} }, params: {}
            });
        assert.ok((await call("GET", "/plugin/web-links")).body.includes('name="seconds" type="number" min="1" max="60" step="1" value="5"'));
        await call("POST", "/plugin/web-links/search-timeout", "seconds=12");
        assert.ok((await call("GET", "/plugin/web-links")).body.includes('value="12"'));
        await call("POST", "/plugin/web-links/search-timeout", "seconds=999");
        assert.ok((await call("GET", "/plugin/web-links")).body.includes('value="60"'), "clamped to 60s");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
