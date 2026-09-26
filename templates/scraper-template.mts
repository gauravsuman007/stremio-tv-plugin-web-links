/**
 * TEMPLATE: a web-links scraper.
 * ===============================
 *
 * This file is self-contained -- it imports nothing from this repo, so you
 * can develop and test a scraper anywhere before dropping it into the
 * plugin's `data/scrapers/` folder.
 *
 * A SCRAPER IS A SMALL PACKAGE, NOT A BARE FILE
 * ------------------------------------------------
 * `<pluginsDir>/web-links/data/scrapers/<id>/` holds one scraper:
 *
 *   - `scraper.json` -- `{ "id": "...", "entry": "your-file.mjs", "version"?: "1.0.0" }`.
 *     The plugin reads this first to know what to load and, on a GitHub
 *     import, whether the fetched build is actually newer.
 *   - whatever `entry` names, plus any supporting files it needs (its own
 *     `node_modules`, if it has real npm dependencies -- see
 *     `stremio-tv-plugin-web-scraper`'s `cinejoy` scraper for a worked
 *     example that ships `playwright-core` this way).
 *
 * A plain scraper like this template needs only the two files: `scraper.json`
 * and its compiled `.mjs`.
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
 * Put the emitted `.mjs` next to a `scraper.json` (see above) under
 * `<pluginsDir>/web-links/data/scrapers/<id>/` -- that folder is this
 * plugin's protected, update-proof directory, see the plugin's own README
 * -- and hit `/plugin/web-links/reload`, or restart stremio-tv, to pick it
 * up. A scraper with heavier dependencies that a bundler can't safely
 * inline (a real browser driver, a native module) may need `.cjs` instead
 * of `.mjs` -- see `stremio-tv-plugin-web-scraper`'s own module doc for
 * why, and make sure `scraper.json`'s `entry` names whichever you produce.
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
    /** Final and immediately fetchable, UNLESS `resolveId` is set -- see
     *  below. Required either way (a placeholder is fine when `resolveId`
     *  is set; it's never used). */
    url: string;
    /** Set this INSTEAD of putting a real URL in `url` above when getting
     *  the real link is expensive (drives a browser) or the link itself is
     *  short-lived (a signed token that can expire between when the user
     *  sees this result and when they actually click it) -- see
     *  `stremio-tv-plugin-web-scraper`'s `cinejoy` scraper for a worked
     *  example. When set, the host calls `resolve()` below with this id
     *  right before the link is actually used, once, at play time, never at
     *  list time, so the URL the user gets is always fresh. */
    resolveId?: string;
    /** Only meaningful alongside `resolveId`. `"file"` (default) redirects
     *  straight to the resolved URL. `"hls"` means it's an `.m3u8` playlist -- either a plain media
     *  playlist or a MASTER with several renditions (return the master
     *  itself, not one flattened variant, and the player offers the viewer a
     *  resolution picker). The host fetches it, and recursively every
     *  variant playlist inside a master, and routes every relative URI
     *  (variants, segments, init sections, keys) back through itself:
     *  same-origin, so the browser can read it, and through the VPN. It
     *  serves the rewritten text directly rather than redirecting, since a
     *  redirect would leave those relative paths resolving against nothing
     *  real. */
    resolveKind?: "file" | "hls";
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
    /** The household VPN's proxy address, when configured -- only needed by
     *  a scraper that opens its own connections outside `ctx.fetch` (e.g.
     *  driving a real browser -- see `stremio-tv-plugin-web-scraper`'s
     *  `cinejoy` scraper for a worked example). */
    proxyUrl?: string;
}

interface WebLinkScraper {
    id: string;
    name: string;
    /** Compared with dot-separated version numbers on a GitHub re-check --
     *  a fetched build only replaces what's running when this is a real
     *  increase. Optional; an unversioned scraper is never known to be an
     *  update to anything. */
    version?: string;
    /** Return ONE result per site, not one per mirror/server: list-time
     *  should be cheap, and which mirror actually serves the video is
     *  `resolve()`'s job -- have it try each in turn until one works, and
     *  tag the single result with this scraper's name (e.g. title:
     *  "Zootopia (2016) \u00b7 CineJoy") so its origin is visible. Order the
     *  mirrors best-quality-first when the site says which are. */
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
    /** Only needed if `search()` ever sets `resolveId` on a result -- turns
     *  that id back into the real, fresh link. Return `null` for "this one's
     *  gone" rather than throwing, when you can tell the difference from the
     *  target site being unreachable. */
    resolve?(resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null>;
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
    version: "1.0.0",
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
