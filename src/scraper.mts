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
    /** The direct (or referrer/UA-guarded) HTTP URL -- final and immediately
     *  fetchable, UNLESS `resolveId` is set. Required either way (a
     *  placeholder string is fine when `resolveId` is set; it is never
     *  used), so a simple scraper needs nothing extra. */
    url: string;
    /** Set when the real URL is expensive to get (a browser-driven capture)
     *  or short-lived (a signed token) -- anything that would go stale, or
     *  cost too much to do for every result, before the user ever clicks
     *  it. When set, `url` above is a placeholder and the host calls
     *  `scraper.resolve(resolveId, ...)` right before actually using this
     *  link -- once, at play time, never at list time -- to get the real,
     *  fresh one. Omit for a plain scraper whose `url` is already final. */
    resolveId?: string;
    /** Only meaningful alongside `resolveId`. `"file"` (the default) means
     *  the resolved `url` is a plain file the host can redirect straight to.
     *  `"hls"` means it's an `.m3u8` playlist -- the host fetches it itself,
     *  rewrites every relative URI inside to absolute (so it plays no
     *  matter which URL the client actually fetched the playlist from), and
     *  serves the rewritten text directly rather than redirecting, since a
     *  redirect would hand the client a playlist full of paths that no
     *  longer resolve against anything real. */
    resolveKind?: "file" | "hls";
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
    /** The household VPN's HTTP proxy address, when one is configured --
     *  for a scraper that opens its OWN connections outside `ctx.fetch`
     *  (e.g. driving a real browser), which `ctx.fetch` has no way to route
     *  on that scraper's behalf. Absent when no VPN is configured. */
    proxyUrl?: string;
}

export interface WebLinkScraper {
    /** Unique, stable, lowercase-with-dashes -- used in logs and settings. */
    id: string;
    name: string;
    /** Compared with `versionSupersedes()` (same convention as stremio-tv's
     *  own plugin/scraper importers) so a GitHub re-check only replaces a
     *  scraper already running with a real, newer version. */
    version?: string;
    /** Return every link this scraper can find for `query`. An empty array
     *  for "no results", never a throw for "not found" -- reserve throwing
     *  for the target site actually being unreachable/erroring. A result
     *  may set `resolveId` instead of a real `url` -- see `WebLink`. */
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
    /** Only needed by a scraper that sets `resolveId` on some of its
     *  `WebLink`s -- turns that id back into the real, fresh link right
     *  before it is used. Called at most once per play attempt (the host
     *  briefly caches the answer so a single play doesn't re-run this for
     *  every internal fetch of the same link), never at list time. Return
     *  `null` for "this one's gone" rather than throwing, when that's
     *  distinguishable from the target site being unreachable. */
    resolve?(resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null>;
}
