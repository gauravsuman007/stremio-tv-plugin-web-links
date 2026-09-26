import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("parseGithubRepo accepts URLs and owner/repo", async () => {
    const { parseGithubRepo } = await import("../dist/plugin.mjs");
    const want = { owner: "a", repo: "b" };
    for (const s of ["a/b", "https://github.com/a/b", "https://github.com/a/b/", "github.com/a/b.git", "git@github.com:a/b.git", "https://github.com/a/b/tree/main/dist"])
        assert.deepEqual(parseGithubRepo(s), want, s);
    for (const s of ["", "a", "a/", "https://github.com/a"]) assert.equal(parseGithubRepo(s), null, s);
});
