import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
/**
 * Loads every scraper package dropped into `<configDir>/scrapers/<id>/`.
 * `configDir` is this plugin's `data/` folder -- protected, update-proof --
 * so scrapers survive a plugin reinstall even though they ship separately
 * from the plugin's own `code/`.
 *
 * A SCRAPER IS A DIRECTORY, NOT A BARE FILE
 * -------------------------------------------
 * A simple scraper (plain HTTP, `ctx.fetch` only) is one file. A scraper
 * that drives a real browser (see `stremio-tv-plugin-web-scraper`'s
 * `cinejoy` scraper) needs its own `node_modules` alongside it too --
 * bundling a dependency-free-at-the-JS-level package like `playwright-core`
 * still isn't safe in general (its own registry code resolves files
 * relative to ITSELF at import time). So every scraper ships as a small
 * package: `<id>/scraper.json` (`{ id, entry, version? }`, the same idea as
 * stremio-tv's own `plugin.json`) plus whatever `entry` (and its own
 * `node_modules`, if any) needs to sit next to it. `github-import.mts`
 * syncs the WHOLE tree a scraper repo publishes under `dist/`, exactly the
 * way stremio-tv's own plugin importer syncs a whole plugin's `dist/`.
 *
 * A scraper that fails to load or throws while loading is skipped, not
 * fatal -- one broken scraper must never take down the whole plugin's
 * ability to answer `extraStreamsFor` for every other scraper.
 *
 * CACHE-BUSTED, LIKE STREMIO-TV'S OWN PLUGIN LOADER
 * -----------------------------------------------------
 * A scraper's compiled file keeps the SAME path across a GitHub re-import
 * (`<id>/<entry>`, the old directory replaced by a fresh one at that same
 * path) -- and Node's ES module cache is keyed by resolved URL, not file
 * content. Without busting it, `import()` here would keep handing back the
 * very first copy of a scraper ever loaded at this path, no matter how
 * many times the file underneath it changes -- exactly the bug stremio-tv's
 * own `plugins.ts#loadPlugins()` already works around with a `?reload=`
 * query param on `plugin.mjs`'s own URL. `reloadCounter` does the same
 * thing here, bumped once per `loadScrapers()` call (i.e. once per
 * successful import or explicit "Reload sources").
 */
let reloadCounter = 0;
/** Which package directory each loaded scraper came from -- a package may
 *  hold several scrapers, and Update acts on the package. */
export const packageOf = new WeakMap();
/** The package manifest's version -- what Update compares, so what to show. */
export const packageVersionOf = new WeakMap();
export async function loadScrapers(configDir) {
    const cacheBust = ++reloadCounter;
    const scrapersDir = path.join(configDir, "scrapers");
    let entries;
    try {
        entries = readdirSync(scrapersDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const scrapers = [];
    for (const id of entries) {
        const scraperDir = path.join(scrapersDir, id);
        try {
            const manifest = JSON.parse(readFileSync(path.join(scraperDir, "scraper.json"), "utf8"));
            if (!manifest.entry) {
                console.warn(`[web-links] ${id}/scraper.json has no "entry", skipping`);
                continue;
            }
            const mod = await import(`${pathToFileURL(path.join(scraperDir, manifest.entry)).href}?reload=${cacheBust}`);
            const found = unwrapScrapers(mod);
            if (!found.length) {
                console.warn(`[web-links] ${id} does not export a WebLinkScraper (needs id, name, search()), skipping`);
            }
            for (const scraper of found) {
                if (scrapers.some((existing) => existing.id === scraper.id)) {
                    console.warn(`[web-links] ${id} exports a scraper whose id "${scraper.id}" is already loaded, skipping that one`);
                    continue;
                }
                packageOf.set(scraper, id);
                if (typeof manifest.version === "string")
                    packageVersionOf.set(scraper, manifest.version);
                scrapers.push(scraper);
            }
        }
        catch (cause) {
            console.warn(`[web-links] failed to load scraper "${id}":`, cause);
        }
    }
    return scrapers;
}
/**
 * A package's entry may export ONE scraper or SEVERAL: a default export that
 * is a `WebLinkScraper`, an array of them, or a named `scrapers` array.
 * Entries that are not scrapers are dropped individually, so one malformed
 * entry never costs the package's others.
 *
 * A scraper compiled to `.mjs` exports a plain ESM default. One compiled to
 * `.cjs` (see the module doc's note on why that's sometimes necessary) goes
 * through Node's CJS/ESM interop first, which -- for a bundler-emitted
 * `{ __esModule: true, default: X }` shape -- leaves `X` one level deeper
 * than a native ESM default (`mod.default.default`, not `mod.default`), and
 * a named export is then only reachable on `mod.default` too. This tries the
 * ESM shape first, the CJS-interop shape second.
 */
function unwrapScrapers(mod) {
    const inner = mod.default?.default;
    const nestedNamed = mod.default?.scrapers;
    for (const candidate of [mod.default, mod.scrapers, inner, nestedNamed]) {
        const list = (Array.isArray(candidate) ? candidate : [candidate]).filter(isWebLinkScraper);
        if (list.length)
            return list;
    }
    return [];
}
function isWebLinkScraper(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.search === "function";
}
