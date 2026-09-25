import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { WebLinkScraper } from "./scraper.mjs";

/**
 * Loads every scraper dropped into `<configDir>/scrapers/*.mjs`.
 * `configDir` is this plugin's `data/` folder -- protected, update-proof --
 * so scrapers survive a plugin reinstall even though they ship separately
 * from the plugin's own `code/`. There are none checked in here today;
 * `templates/scraper-template.mts` is what a new scraper starts from.
 *
 * A scraper that fails to load or throws while loading is skipped, not
 * fatal -- one broken scraper must never take down the whole plugin's
 * ability to answer `extraStreamsFor` for every other scraper.
 */
export async function loadScrapers(configDir: string): Promise<WebLinkScraper[]> {
    const scrapersDir = path.join(configDir, "scrapers");
    let entries: string[];
    try {
        entries = await readdir(scrapersDir);
    } catch {
        return [];
    }

    const scrapers: WebLinkScraper[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".mjs")) continue;
        try {
            const mod = await import(pathToFileURL(path.join(scrapersDir, entry)).href);
            const scraper: unknown = mod.default;
            if (isWebLinkScraper(scraper)) {
                scrapers.push(scraper);
            } else {
                console.warn(`[web-links] ${entry} does not default-export a WebLinkScraper, skipping`);
            }
        } catch (cause) {
            console.warn(`[web-links] failed to load scraper ${entry}:`, cause);
        }
    }
    return scrapers;
}

function isWebLinkScraper(value: unknown): value is WebLinkScraper {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.search === "function";
}
