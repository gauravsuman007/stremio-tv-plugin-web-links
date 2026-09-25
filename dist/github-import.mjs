/**
 * Pulling a scraper package in from a GitHub repository's `dist/` folder,
 * instead of copying files onto the host by hand. Mirrors stremio-tv's own
 * `plugin-import.ts` (whole-tree sync, `versionSupersedes` gate) rather
 * than the Live TV plugin's single-file `github-import.ts` -- a scraper
 * here is a small package (`scraper.json` + its entry + optionally its own
 * `node_modules`), not one `.mjs` file, so the whole `dist/` tree has to be
 * fetched and synced, exactly like installing a whole plugin.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const SCRAPER_ID_RE = /^[a-z0-9-]{1,64}$/;
const BRANCH = "main";
/** `true` when `next` is a real, comparable increase over `current`. */
export function versionSupersedes(next, current) {
    if (!next)
        return false;
    if (!current)
        return true;
    const a = next.split(".").map((part) => parseInt(part, 10) || 0);
    const b = current.split(".").map((part) => parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y)
            return x > y;
    }
    return false;
}
let sources = [];
let sourcesLoaded = false;
let storePath = "";
export function initGithubImport(configDir) {
    storePath = join(configDir, "scraper-sources.json");
}
function ensureSourcesLoaded() {
    if (sourcesLoaded)
        return;
    sourcesLoaded = true;
    if (!storePath)
        return;
    try {
        const parsed = JSON.parse(readFileSync(storePath, "utf8"));
        sources = (parsed.sources || []).filter((s) => s && typeof s.owner === "string" && typeof s.repo === "string");
    }
    catch {
        /* no store yet, or unreadable -- same posture as a first boot */
    }
}
function persistSources() {
    if (!storePath)
        return;
    try {
        mkdirSync(dirname(storePath), { recursive: true });
        const temporary = `${storePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ sources }), { mode: 0o600 });
        renameSync(temporary, storePath);
    }
    catch (cause) {
        console.error("web-links: could not write the scraper sources store", cause);
    }
}
const keyOf = (owner, repo) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;
export function listGithubSources() {
    ensureSourcesLoaded();
    return sources.map(({ owner, repo, token }) => ({ owner, repo, hasToken: !!token }));
}
export function rememberGithubSource(owner, repo, token) {
    ensureSourcesLoaded();
    const key = keyOf(owner, repo);
    const existing = sources.find((s) => keyOf(s.owner, s.repo) === key);
    const resolved = { owner, repo, token: token || existing?.token || "" };
    sources = [...sources.filter((s) => keyOf(s.owner, s.repo) !== key), resolved];
    persistSources();
    return resolved;
}
export function forgetGithubSource(owner, repo) {
    ensureSourcesLoaded();
    sources = sources.filter((s) => keyOf(s.owner, s.repo) !== keyOf(owner, repo));
    persistSources();
}
function findSource(owner, repo) {
    ensureSourcesLoaded();
    return sources.find((s) => keyOf(s.owner, s.repo) === keyOf(owner, repo));
}
async function githubApi(path, token) {
    const response = await fetch(`https://api.github.com/${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "stremio-tv-plugin-web-links",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
    });
    if (response.status === 404) {
        throw new Error(token
            ? "not found -- check the repo, branch and dist/ path, and that the token can read this repo"
            : "not found -- check the repo and branch, or add a token if this is a private repo");
    }
    if (response.status === 401 || response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        throw new Error(remaining === "0" ? "GitHub's rate limit was hit -- add a token, or try again shortly" : "GitHub refused that token (401/403)");
    }
    if (!response.ok)
        throw new Error(`GitHub API -> ${response.status}`);
    return response.json();
}
/**
 * Every file under `<repo>/dist` on `main`, via the Git Trees API rather
 * than the Contents API: a scraper package can be genuinely large (the
 * `cinejoy` scraper ships a several-MB bundled `playwright-core`), and the
 * Contents API silently omits `content` for anything over 1MB -- fetching
 * one of those "successfully" and writing an empty/missing file is exactly
 * the bug that motivated this. The Trees+Blobs API supports files up to
 * 100MB and, as a bonus, lists the whole tree in one recursive call
 * instead of one request per directory.
 */
async function listDistFiles(owner, repo, token) {
    const tree = await githubApi(`repos/${owner}/${repo}/git/trees/${BRANCH}?recursive=1`, token);
    if (tree.truncated) {
        throw new Error("this repository's tree is too large for GitHub's non-paginated tree API -- split dist/ up or ask upstream");
    }
    return tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith("dist/"));
}
/**
 * A file's raw bytes, straight from `raw.githubusercontent.com` -- not the
 * git blobs JSON endpoint this started as. That endpoint is documented for
 * files up to 100MB, but in practice it silently truncated `content` well
 * under that for this scraper's ~3.4MB bundled `playwright-core` file too
 * (caught the same way the original 1MB Contents-API bug was: by actually
 * importing the real repo and checking the file landed at its full size,
 * not by trusting either endpoint's documented limit). Plain raw content
 * has no such wrapping to get wrong. Works for a private repo the same
 * token can read: GitHub honors `Authorization: Bearer <token>` on
 * raw.githubusercontent.com exactly like the API host.
 */
async function fetchRawFile(owner, repo, path, token) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${BRANCH}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (!response.ok)
        throw new Error(`could not download ${path} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
}
/**
 * Fetches every file under `<repo>/dist` on `main`, reads `scraper.json`
 * (`{ id, entry, version? }`) to learn the id this install belongs under,
 * and replaces `<configDir>/scrapers/<id>/` with the fetched tree -- but
 * only when `versionSupersedes` says this is a real update, or the id is
 * new.
 */
export async function importScraperFromGithub(configDir, owner, repo, token) {
    const files = await listDistFiles(owner, repo, token);
    if (!files.length)
        return { updated: false, fileCount: 0, error: "no files in dist/ on that branch" };
    const manifestEntry = files.find((entry) => entry.path === "dist/scraper.json");
    if (!manifestEntry)
        return { updated: false, fileCount: 0, error: "dist/scraper.json is missing -- expected { id, entry, version? }" };
    let manifest;
    try {
        manifest = JSON.parse((await fetchRawFile(owner, repo, manifestEntry.path, token)).toString("utf8"));
    }
    catch (cause) {
        return {
            updated: false,
            fileCount: 0,
            error: cause instanceof Error && cause.message.includes("content") ? cause.message : "scraper.json is not valid JSON"
        };
    }
    if (!manifest.id || !SCRAPER_ID_RE.test(manifest.id)) {
        return { updated: false, fileCount: 0, error: `scraper.json's id "${manifest.id}" is not a usable scraper id` };
    }
    if (!manifest.entry) {
        return { updated: false, fileCount: 0, error: "scraper.json is missing \"entry\"" };
    }
    const scraperRoot = join(configDir, "scrapers", manifest.id);
    const existingVersion = readInstalledVersion(scraperRoot);
    if (existingVersion !== undefined && !versionSupersedes(manifest.version, existingVersion)) {
        return {
            id: manifest.id,
            version: manifest.version,
            updated: false,
            fileCount: files.length,
            error: existingVersion
                ? `already have v${existingVersion}${manifest.version ? `, this is v${manifest.version}` : " (this build has no version)"}`
                : "already installed, and this build has no version to compare"
        };
    }
    mkdirSync(join(configDir, "scrapers"), { recursive: true });
    const stagingDir = join(configDir, "scrapers", `.import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stagingDir, { recursive: true });
    try {
        for (const entry of files) {
            const relative = entry.path.replace(/^dist\//, "");
            const content = await fetchRawFile(owner, repo, entry.path, token);
            const destination = join(stagingDir, relative);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, content);
        }
        rmSync(scraperRoot, { recursive: true, force: true });
        renameSync(stagingDir, scraperRoot);
        return { id: manifest.id, version: manifest.version, updated: true, fileCount: files.length };
    }
    catch (cause) {
        return {
            id: manifest.id,
            version: manifest.version,
            updated: false,
            fileCount: files.length,
            error: cause instanceof Error ? cause.message : String(cause)
        };
    }
    finally {
        try {
            rmSync(stagingDir, { recursive: true, force: true });
        }
        catch {
            /* best effort -- already renamed away on the success path */
        }
    }
}
function readInstalledVersion(scraperDir) {
    try {
        const manifest = JSON.parse(readFileSync(join(scraperDir, "scraper.json"), "utf8"));
        return manifest.version;
    }
    catch {
        return undefined;
    }
}
export async function importScraperFromStoredSource(configDir, owner, repo) {
    const source = findSource(owner, repo);
    if (!source)
        return { updated: false, fileCount: 0, error: "that source is not configured" };
    return importScraperFromGithub(configDir, source.owner, source.repo, source.token);
}
