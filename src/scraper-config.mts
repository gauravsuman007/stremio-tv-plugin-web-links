import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Which dropped-in scrapers are switched on. Stored in `configDir` (this
 *  plugin's protected `data/` folder), so it survives every plugin update
 *  the same way the scrapers themselves do. Missing == enabled by default,
 *  the same posture as Live TV's own scraper toggle -- a scraper you just
 *  imported should work immediately, not need a second step to turn on. */
let path = "";
let off = new Set<string>();
let loaded = false;

export function initScraperConfig(configDir: string): void {
    path = join(configDir, "scraper-state.json");
}

function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    if (!path) return;

    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { off?: string[] };
        off = new Set(parsed.off || []);
    } catch {
        /* no store yet, or unreadable -- everything enabled is the default */
    }
}

function persist(): void {
    if (!path) return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify({ off: [...off] }));
        renameSync(temporary, path);
    } catch (cause) {
        console.error("web-links: could not write scraper-state.json", cause);
    }
}

export function scraperEnabled(id: string): boolean {
    ensureLoaded();
    return !off.has(id);
}

export function setScraperEnabled(id: string, enabled: boolean): void {
    ensureLoaded();
    if (enabled) off.delete(id);
    else off.add(id);
    persist();
}
