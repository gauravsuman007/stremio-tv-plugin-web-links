import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/** Which dropped-in scrapers are switched on. Stored in `configDir` (this
 *  plugin's protected `data/` folder), so it survives every plugin update
 *  the same way the scrapers themselves do. Missing == enabled by default,
 *  the same posture as Live TV's own scraper toggle -- a scraper you just
 *  imported should work immediately, not need a second step to turn on. */
let path = "";
let off = new Set();
/** How long a title's scraper search may take, set on the settings page. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
export const MIN_SEARCH_TIMEOUT_MS = 1_000;
export const MAX_SEARCH_TIMEOUT_MS = 60_000;
let searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS;
let loaded = false;
export function initScraperConfig(configDir) {
    path = join(configDir, "scraper-state.json");
    // A reloaded plugin instance may point at another directory: read it afresh.
    loaded = false;
    off = new Set();
    searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT_MS;
}
function ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    if (!path)
        return;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        off = new Set(parsed.off || []);
        if (typeof parsed.searchTimeoutMs === "number")
            searchTimeoutMs = clampTimeout(parsed.searchTimeoutMs);
    }
    catch {
        /* no store yet, or unreadable -- everything enabled is the default */
    }
}
function persist() {
    if (!path)
        return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify({ off: [...off], searchTimeoutMs }));
        renameSync(temporary, path);
    }
    catch (cause) {
        console.error("web-links: could not write scraper-state.json", cause);
    }
}
export function scraperEnabled(id) {
    ensureLoaded();
    return !off.has(id);
}
export function setScraperEnabled(id, enabled) {
    ensureLoaded();
    if (enabled)
        off.delete(id);
    else
        off.add(id);
    persist();
}
function clampTimeout(ms) {
    return Number.isFinite(ms) ? Math.min(MAX_SEARCH_TIMEOUT_MS, Math.max(MIN_SEARCH_TIMEOUT_MS, Math.round(ms))) : DEFAULT_SEARCH_TIMEOUT_MS;
}
/** The budget every scraper's `search()` gets for one title (they run at once). */
export function getSearchTimeoutMs() {
    ensureLoaded();
    return searchTimeoutMs;
}
export function setSearchTimeoutMs(ms) {
    ensureLoaded();
    searchTimeoutMs = clampTimeout(ms);
    persist();
}
