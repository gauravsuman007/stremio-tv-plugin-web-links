import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHost = {
    requestVpnCapability: async () => ({ configured: false }),
    vpnBadge: () => "",
    vpnSheet: () => "",
    render: { escape: (v) => String(v), page: (opts) => opts.body, chrome: () => "" }
};

const b64 = (v) => Buffer.from(v, "utf8").toString("base64url");

/** An upstream that answers 403 unless Referer AND Origin match, and echoes
 *  what it saw for anything else. */
function startUpstream() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers);
        if (req.headers.referer !== "https://site.example/" || req.headers.origin !== "https://site.example") {
            res.writeHead(403).end("forbidden");
            return;
        }
        if (req.url === "/master.m3u8") {
            res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
            res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\nleaf.m3u8\n");
        } else if (req.url === "/leaf.m3u8") {
            res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
            res.end("#EXTM3U\n#EXTINF:5,\nseg.ts\n#EXT-X-ENDLIST\n");
        } else {
            res.writeHead(200, { "content-type": "video/mp2t" });
            res.end(Buffer.from([0x47, 1, 2, 3, 4, 5, 6, 7, 8]));
        }
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

async function withPlugin(fn) {
    const { default: createPlugin } = await import("../dist/plugin.mjs");
    const dir = mkdtempSync(join(tmpdir(), "web-links-relay-"));
    try {
        const routes = createPlugin(fakeHost, dir).routes();
        const route = (path) => routes.find((r) => r.method === "GET" && r.path === `/plugin/web-links/${path}`);
        const call = (path, params, headers = {}) =>
            route(path).handle({ method: "GET", path, query: new URLSearchParams(params), form: new URLSearchParams(), headers, client: { link: (p) => p, session: {} }, params: {} });
        await fn(call);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the relay sends a link's Origin as well as its Referer, through variant and segment", async () => {
    const up = await startUpstream();
    try {
        await withPlugin(async (call) => {
            const hdr = b64(JSON.stringify({ Origin: "https://site.example" }));
            const ref = b64("https://site.example/");

            // Referer alone is refused by this upstream.
            const refOnly = await call("variant", { u: b64(`${up.base}/master.m3u8`), ref });
            assert.equal(refOnly.status, 502);

            const master = await call("variant", { u: b64(`${up.base}/master.m3u8`), ref, hdr });
            assert.equal(master.status, 200);
            const body = String(master.body);
            // The nested playlist link carries the same headers on to the next hop.
            const next = /variant\?([^\s]+)/.exec(body);
            assert.ok(next, "the master's variant line is rewritten");
            const nextParams = new URLSearchParams(next[1]);
            assert.equal(nextParams.get("hdr"), hdr);

            const leaf = await call("variant", Object.fromEntries(nextParams));
            assert.equal(leaf.status, 200);
            const segLink = /segment\?([^\s]+)/.exec(String(leaf.body));
            assert.ok(segLink, "the leaf's segment line is rewritten");

            const segment = await call("segment", Object.fromEntries(new URLSearchParams(segLink[1])));
            assert.equal(segment.status, 200);
            assert.equal(segment.headers["content-type"], "video/mp2t");
        });
    } finally {
        up.server.close();
    }
});

test("the relay drops headers a link has no business setting", async () => {
    const up = await startUpstream();
    try {
        await withPlugin(async (call) => {
            const hdr = b64(
                JSON.stringify({ Origin: "https://site.example", Cookie: "s=1", Authorization: "Bearer x", Host: "evil.example", "X-Player-Key": "k", "X-Bad": "a\r\nInjected: 1" })
            );
            const response = await call("segment", { u: b64(`${up.base}/seg.ts`), ref: b64("https://site.example/"), hdr });
            assert.equal(response.status, 200);

            const sent = up.seen.at(-1);
            assert.equal(sent.origin, "https://site.example");
            assert.equal(sent["x-player-key"], "k");
            assert.equal(sent.cookie, undefined);
            assert.equal(sent.authorization, undefined);
            assert.notEqual(sent.host, "evil.example");
            assert.equal(sent["x-bad"], undefined);
            assert.equal(sent.injected, undefined);
        });
    } finally {
        up.server.close();
    }
});

test("a malformed hdr parameter is ignored, not an error", async () => {
    const up = await startUpstream();
    try {
        await withPlugin(async (call) => {
            const response = await call("segment", { u: b64(`${up.base}/seg.ts`), ref: b64("https://site.example/"), hdr: "!!!not-base64-json" });
            // No usable extra headers, so this upstream (which wants Origin) refuses: relayed as its 403, not a crash.
            assert.equal(response.status, 403);
        });
    } finally {
        up.server.close();
    }
});
