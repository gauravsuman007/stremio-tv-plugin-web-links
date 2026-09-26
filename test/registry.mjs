import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const write = (dir, version, extra = "") => {
    writeFileSync(join(dir, "scraper.json"), JSON.stringify({ id: "pkg", entry: "e.cjs", version }));
    writeFileSync(
        join(dir, "e.cjs"),
        `const mk=(id)=>({id,name:id+" ${version}",search:async()=>[]});module.exports={__esModule:true,default:[mk("a"),mk("b")${extra}]};`
    );
};

test("a package exporting an array registers every scraper", async () => {
    const { loadScrapers } = await import("../dist/registry.mjs");
    const root = mkdtempSync(join(tmpdir(), "web-links-reg-"));
    const dir = join(root, "scrapers", "pkg");
    mkdirSync(dir, { recursive: true });
    try {
        write(dir, "1.0.0", ",{bad:1}");
        assert.deepEqual((await loadScrapers(root)).map((s) => s.id), ["a", "b"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("reloading a .cjs package after an update runs the new code, not the cached old one", async () => {
    const { loadScrapers } = await import("../dist/registry.mjs");
    const root = mkdtempSync(join(tmpdir(), "web-links-reg-"));
    const dir = join(root, "scrapers", "pkg");
    mkdirSync(dir, { recursive: true });
    try {
        write(dir, "1.0.0");
        assert.equal((await loadScrapers(root))[0].name, "a 1.0.0");
        write(dir, "2.0.0");
        assert.equal((await loadScrapers(root))[0].name, "a 2.0.0");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
