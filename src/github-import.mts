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
export function versionSupersedes(next: string | undefined, current: string | undefined): boolean {
    if (!next) return false;
    if (!current) return true;

    const a = next.split(".").map((part) => parseInt(part, 10) || 0);
    const b = current.split(".").map((part) => parseInt(part, 10) || 0);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

export interface GithubSource {
    owner: string;
    repo: string;
}

interface StoredSource extends GithubSource {
    token: string;
}

let sources: StoredSource[] = [];
let sourcesLoaded = false;
let storePath = "";

export function initGithubImport(configDir: string): void {
    storePath = join(configDir, "scraper-sources.json");
}

function ensureSourcesLoaded(): void {
    if (sourcesLoaded) return;
    sourcesLoaded = true;
    if (!storePath) return;

    try {
        const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { sources?: StoredSource[] };
        sources = (parsed.sources || []).filter((s) => s && typeof s.owner === "string" && typeof s.repo === "string");
    } catch {
        /* no store yet, or unreadable -- same posture as a first boot */
    }
}

function persistSources(): void {
    if (!storePath) return;
    try {
        mkdirSync(dirname(storePath), { recursive: true });
        const temporary = `${storePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ sources }), { mode: 0o600 });
        renameSync(temporary, storePath);
    } catch (cause) {
        console.error("web-links: could not write the scraper sources store", cause);
    }
}

const keyOf = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

export function listGithubSources(): (GithubSource & { hasToken: boolean })[] {
    ensureSourcesLoaded();
    return sources.map(({ owner, repo, token }) => ({ owner, repo, hasToken: !!token }));
}

export function rememberGithubSource(owner: string, repo: string, token: string): StoredSource {
    ensureSourcesLoaded();
    const key = keyOf(owner, repo);
    const existing = sources.find((s) => keyOf(s.owner, s.repo) === key);
    const resolved: StoredSource = { owner, repo, token: token || existing?.token || "" };
    sources = [...sources.filter((s) => keyOf(s.owner, s.repo) !== key), resolved];
    persistSources();
    return resolved;
}

export function forgetGithubSource(owner: string, repo: string): void {
    ensureSourcesLoaded();
    sources = sources.filter((s) => keyOf(s.owner, s.repo) !== keyOf(owner, repo));
    persistSources();
}

function findSource(owner: string, repo: string): StoredSource | undefined {
    ensureSourcesLoaded();
    return sources.find((s) => keyOf(s.owner, s.repo) === keyOf(owner, repo));
}

interface GithubContentEntry {
    name: string;
    type: string;
    path: string;
}

async function githubApi<T>(path: string, token: string): Promise<T> {
    const response = await fetch(`https://api.github.com/${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "stremio-tv-plugin-web-links",
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
    });

    if (response.status === 404) {
        throw new Error(
            token
                ? "not found -- check the repo, branch and dist/ path, and that the token can read this repo"
                : "not found -- check the repo and branch, or add a token if this is a private repo"
        );
    }
    if (response.status === 401 || response.status === 403) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        throw new Error(
            remaining === "0" ? "GitHub's rate limit was hit -- add a token, or try again shortly" : "GitHub refused that token (401/403)"
        );
    }
    if (!response.ok) throw new Error(`GitHub API -> ${response.status}`);

    return response.json() as Promise<T>;
}

async function listDistFiles(owner: string, repo: string, token: string, path = "dist"): Promise<GithubContentEntry[]> {
    const listing = await githubApi<GithubContentEntry[] | GithubContentEntry>(
        `repos/${owner}/${repo}/contents/${path}?ref=${BRANCH}`,
        token
    );
    const entries = Array.isArray(listing) ? listing : [listing];
    const files: GithubContentEntry[] = [];

    for (const entry of entries) {
        if (entry.type === "file") files.push(entry);
        else if (entry.type === "dir") files.push(...(await listDistFiles(owner, repo, token, entry.path)));
    }
    return files;
}

export interface ScraperImportResult {
    id?: string;
    version?: string;
    updated: boolean;
    fileCount: number;
    error?: string;
}

/**
 * Fetches every file under `<repo>/dist` on `main`, reads `scraper.json`
 * (`{ id, entry, version? }`) to learn the id this install belongs under,
 * and replaces `<configDir>/scrapers/<id>/` with the fetched tree -- but
 * only when `versionSupersedes` says this is a real update, or the id is
 * new.
 */
export async function importScraperFromGithub(configDir: string, owner: string, repo: string, token: string): Promise<ScraperImportResult> {
    const files = await listDistFiles(owner, repo, token);

    if (!files.length) return { updated: false, fileCount: 0, error: "no files in dist/ on that branch" };

    const manifestEntry = files.find((entry) => entry.name === "scraper.json");
    if (!manifestEntry) return { updated: false, fileCount: 0, error: "dist/scraper.json is missing -- expected { id, entry, version? }" };

    const manifestFile = await githubApi<{ content?: string; encoding?: string }>(
        `repos/${owner}/${repo}/contents/${manifestEntry.path}?ref=${BRANCH}`,
        token
    );
    if (!manifestFile.content || manifestFile.encoding !== "base64") {
        return { updated: false, fileCount: 0, error: "GitHub did not return scraper.json's content" };
    }

    let manifest: { id?: string; entry?: string; version?: string };
    try {
        manifest = JSON.parse(Buffer.from(manifestFile.content, "base64").toString("utf8"));
    } catch {
        return { updated: false, fileCount: 0, error: "scraper.json is not valid JSON" };
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
            const file = await githubApi<{ content?: string; encoding?: string }>(
                `repos/${owner}/${repo}/contents/${entry.path}?ref=${BRANCH}`,
                token
            );
            if (!file.content || file.encoding !== "base64") continue;

            const destination = join(stagingDir, relative);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, Buffer.from(file.content, "base64"));
        }

        rmSync(scraperRoot, { recursive: true, force: true });
        renameSync(stagingDir, scraperRoot);

        return { id: manifest.id, version: manifest.version, updated: true, fileCount: files.length };
    } catch (cause) {
        return {
            id: manifest.id,
            version: manifest.version,
            updated: false,
            fileCount: files.length,
            error: cause instanceof Error ? cause.message : String(cause)
        };
    } finally {
        try {
            rmSync(stagingDir, { recursive: true, force: true });
        } catch {
            /* best effort -- already renamed away on the success path */
        }
    }
}

function readInstalledVersion(scraperDir: string): string | undefined {
    try {
        const manifest = JSON.parse(readFileSync(join(scraperDir, "scraper.json"), "utf8")) as { version?: string };
        return manifest.version;
    } catch {
        return undefined;
    }
}

export async function importScraperFromStoredSource(configDir: string, owner: string, repo: string): Promise<ScraperImportResult> {
    const source = findSource(owner, repo);
    if (!source) return { updated: false, fileCount: 0, error: "that source is not configured" };
    return importScraperFromGithub(configDir, source.owner, source.repo, source.token);
}
