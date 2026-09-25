/**
 * TEMPLATE: a web-links scraper.
 * ===============================
 *
 * This file is self-contained -- it imports nothing from this repo, so you
 * can develop and test a scraper anywhere before dropping the compiled
 * `.mjs` into the plugin's `data/scrapers/` folder.
 *
 * WHAT A SCRAPER IS
 * ------------------
 * A default export matching `WebLinkScraper` below: given a title (and,
 * for a series episode, season/episode numbers), return every HTTP link
 * your target site has for it. That's the entire job. The plugin host
 * runs every dropped-in scraper for each title lookup, merges their
 * results, and hands them to stremio-tv as supplementary stream options.
 *
 * WHAT A SCRAPER NEVER DOES
 * --------------------------
 * - Resolve or guess quality beyond a free-text label (`quality` below) --
 *   never trusted or parsed by the host, only shown to the user.
 * - Cache across calls -- the host may do that; a scraper is called fresh
 *   each time and should return quickly (see `ctx.budgetMs`) or return
 *   what it has so far.
 * - Handle resume, seeking, or playback position in ANY way. That is
 *   deliberately out of scope -- see the module doc in `scraper.mts` (or
 *   `docs/RESUME.md` in this repo) for why: a link is just a link, and
 *   stremio-tv's own player owns seeking for every source, scraped or not.
 * - Make its own decision about routing through the household VPN --
 *   `ctx.fetch` is already VPN-aware when a tunnel is configured. Always
 *   use `ctx.fetch`, never Node's global `fetch`, for any request your
 *   scraper makes.
 *
 * COMPILE IT YOURSELF
 * ---------------------
 * Name the source file `.mts`, then:
 *
 *     tsc --strict --noUncheckedIndexedAccess --target ES2022 \
 *         --module ES2022 --moduleResolution bundler \
 *         <your-scraper>.mts
 *
 * Drop the emitted `.mjs` into the plugin's `data/scrapers/` folder (that
 * folder is this plugin's protected, update-proof directory -- see the
 * plugin's own README) and hit `/plugin/web-links/reload`, or restart
 * stremio-tv, to pick it up.
 */

/* ---- the contract this file implements ---------------------------------- */

interface WebLinkQuery {
    type: string;
    id: string;
    title: string;
    year?: number;
    season?: number;
    episode?: number;
}

interface WebLink {
    url: string;
    quality?: string;
    title?: string;
    size?: string;
    labels?: string[];
    referrer?: string;
    userAgent?: string;
}

interface ScraperContext {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    budgetMs: number;
}

interface WebLinkScraper {
    id: string;
    name: string;
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
}

/* ---- a minimal, working example ------------------------------------------ */

const SCRAPER_ID = "example-site";

async function search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]> {
    // Replace with a real search request against your target site.
    // Always use `ctx.fetch`, not the global `fetch`, so this scraper's
    // traffic gets routed through the household VPN when one is set up.
    const response = await ctx.fetch(`https://example.invalid/search?q=${encodeURIComponent(query.title)}`);
    if (!response.ok) return [];

    // ... parse `await response.text()` into real results here ...
    return [
        {
            url: "https://example.invalid/download/example.mp4",
            quality: "1080p WEB-DL",
            title: `${query.title} example release`,
            size: "2.1 GB"
        }
    ];
}

const exampleScraper: WebLinkScraper = {
    id: SCRAPER_ID,
    name: "Example Site",
    search
};

export default exampleScraper;

// -------------------------------------------------------------------------
// A quick manual test you can run standalone: `npx tsx scraper-template.mts`
// -------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    exampleScraper
        .search(
            { type: "movie", id: "tt0000000", title: "Example Title" },
            { fetch: (url, init) => fetch(url, init), budgetMs: 8000 }
        )
        .then((links) => console.log("links:", links))
        .catch((cause) => {
            console.error("threw:", cause);
            process.exitCode = 1;
        });
}
