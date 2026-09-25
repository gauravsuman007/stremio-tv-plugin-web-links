/**
 * The contract every web-link scraper implements. A scraper answers one
 * question -- "what HTTP links does this site have for this title?" -- and
 * nothing else. It does not resolve quality itself beyond a free-text
 * label (exactly how addon streams already convey quality via `name`/
 * `title` -- see `Stream` in stremio-tv's `addons.ts`), does not cache
 * across calls (the host may do that), and never touches playback.
 *
 * NO RESUME/SEEK HOOK -- AND THAT'S DELIBERATE
 * ----------------------------------------------
 * A scraper hands back a URL, nothing else. Seeking to a resume position
 * is a player-layer concern: it needs the actual `<video>`/hls.js/mpv
 * instance, knowledge of whether THIS PARTICULAR link honors a `Range`
 * request, and buffering state a scraper has no visibility into. Baking
 * "start at timestamp" into this contract would force every scraper author
 * to reason about how their target site's links behave under a `Range`
 * header or a `#t=` fragment -- most of which are short-lived, tokenized,
 * or simply don't support it -- for a feature the host app already owns
 * end to end (stremio-tv resumes any stream, from any source, the same
 * way). See `docs/RESUME.md`.
 */

export interface WebLinkQuery {
    /** "movie" or "series", passed through from stremio-tv's own content type. */
    type: string;
    /** The content id stremio-tv is resolving streams for (e.g. an IMDb id). */
    id: string;
    /** Best-known display title -- what to actually search the target site for. */
    title: string;
    year?: number;
    /** Present only when `type` is a series episode. */
    season?: number;
    episode?: number;
}

export interface WebLink {
    /** The direct (or referrer/UA-guarded) HTTP URL. Required. */
    url: string;
    /** Free-text quality label, e.g. "1080p WEB-DL" -- shown to the user,
     *  never parsed or trusted by the host. */
    quality?: string;
    /** A short display title for this specific link, e.g. the release name. */
    title?: string;
    /** Human-readable file size, e.g. "2.1 GB". */
    size?: string;
    /** Extra short labels shown alongside quality, e.g. ["HDR", "5.1"]. */
    labels?: string[];
    /** Set when the target requires a specific Referer to serve the file. */
    referrer?: string;
    /** Set when the target requires a specific User-Agent to serve the file. */
    userAgent?: string;
}

/** What a scraper is given to make its own HTTP calls with. Deliberately a
 *  single `fetch`-shaped function rather than a raw VPN handle: whether
 *  traffic is routed through the household tunnel is a decision this
 *  plugin's host makes once per search (see `src/vpn-fetch.mts`), not
 *  something each scraper should have to ask about itself. */
export interface ScraperContext {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    /** Milliseconds remaining before the host gives up on this scraper and
     *  moves on -- a scraper doing multiple round trips (search page, then
     *  a detail page) should stop opening new requests once this is low. */
    budgetMs: number;
}

export interface WebLinkScraper {
    /** Unique, stable, lowercase-with-dashes -- used in logs and settings. */
    id: string;
    name: string;
    /** Return every link this scraper can find for `query`. An empty array
     *  for "no results", never a throw for "not found" -- reserve throwing
     *  for the target site actually being unreachable/erroring. */
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
}
