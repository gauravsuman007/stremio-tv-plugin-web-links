import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { importScraperFromGithub } = await import("../dist/github-import.mjs");

const sha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
let repoFiles = {};

globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes("/git/trees/"))
        return Response.json({ truncated: false, tree: Object.entries(repoFiles).map(([path, c]) => ({ path, type: "blob", sha: sha(Buffer.from(c)) })) });
    const path = decodeURIComponent(url.split("/main/")[1]);
    return repoFiles[path] === undefined ? new Response("", { status: 404 }) : new Response(repoFiles[path]);
};

const pkg = (id, version, extra = "") => ({ [`scraper.json`]: JSON.stringify({ id, entry: `${id}.mjs`, version }), [`${id}.mjs`]: `export default {}; ${extra}` });
const under = (dir, files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`dist/${dir}${k}`, v]));
const ver = (dir, id) => JSON.parse(readFileSync(join(dir, "scrapers", id, "scraper.json"), "utf8")).version;

test("installs new packages, updates bumped ones, leaves current ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    repoFiles = { ...under("a/", pkg("alpha", "1.0.0")), ...under("b/", pkg("beta", "1.0.0")) };
    let r = await importScraperFromGithub(dir, "o", "r", "");
    assert.ok(r.updated);
    assert.equal(ver(dir, "alpha"), "1.0.0");
    assert.equal(ver(dir, "beta"), "1.0.0");

    // alpha bumped, beta untouched, gamma brand new
    repoFiles = { ...under("a/", pkg("alpha", "1.1.0")), ...under("b/", pkg("beta", "1.0.0")), ...under("c/", pkg("gamma", "0.1.0")) };
    r = await importScraperFromGithub(dir, "o", "r", "");
    assert.ok(r.updated);
    assert.match(r.summary, /updated alpha v1\.1\.0/);
    assert.match(r.summary, /installed gamma/);
    assert.match(r.summary, /beta v1\.0\.0 already current/);
    assert.equal(ver(dir, "alpha"), "1.1.0");
    assert.ok(existsSync(join(dir, "scrapers", "gamma", "gamma.mjs")));

    // nothing changed
    r = await importScraperFromGithub(dir, "o", "r", "");
    assert.equal(r.updated, false);
    assert.equal(r.upToDate, true);

    // same version, files changed -> picked up
    repoFiles = { ...under("a/", pkg("alpha", "1.1.0", "// changed")), ...under("b/", pkg("beta", "1.0.0")), ...under("c/", pkg("gamma", "0.1.0")) };
    r = await importScraperFromGithub(dir, "o", "r", "");
    assert.ok(r.updated);
    assert.match(readFileSync(join(dir, "scrapers", "alpha", "alpha.mjs"), "utf8"), /changed/);

    // one bad package does not stop the rest
    repoFiles = { ...under("a/", pkg("alpha", "2.0.0")), "dist/b/scraper.json": "{nope" };
    r = await importScraperFromGithub(dir, "o", "r", "");
    assert.ok(r.updated);
    assert.ok(r.error);
    assert.equal(ver(dir, "alpha"), "2.0.0");

    // per-package update only touches that package
    repoFiles = { ...under("a/", pkg("alpha", "3.0.0")), ...under("c/", pkg("gamma", "9.0.0")) };
    r = await importScraperFromGithub(dir, "o", "r", "", "alpha");
    assert.equal(ver(dir, "alpha"), "3.0.0");
    assert.equal(ver(dir, "gamma"), "0.1.0");
});

test("root package plus sub-packages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    repoFiles = { ...under("", pkg("rooty", "1.0.0")), ...under("sub/", pkg("subby", "1.0.0")) };
    const r = await importScraperFromGithub(dir, "o", "r", "");
    assert.ok(r.updated);
    assert.ok(!existsSync(join(dir, "scrapers", "rooty", "sub")), "sub package files stay out of the root package");
    assert.equal(ver(dir, "subby"), "1.0.0");
});
