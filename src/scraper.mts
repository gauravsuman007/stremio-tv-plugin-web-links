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
     *  link -- once, at play time -- to get the real, fresh one. A scraper
     *  whose resolving is cheap may resolve during `search()` anyway, to
     *  report the real `quality`/`height`, and still set `resolveId` so the
     *  URL is re-checked when played rather than trusted from the list.
     *  Omit for a plain scraper whose `url` is already final. */
    resolveId?: string;
    /** Only meaningful alongside `resolveId`. `"file"` (the default) means
     *  the resolved `url` is a plain file the host can redirect straight to.
     *  `"hls"` means it's an `.m3u8` playlist -- either a plain media
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
    /** Free-text quality label, e.g. "1080p WEB-DL" -- shown to the user,
     *  never parsed or trusted by the host. */
    quality?: string;
    /** The best vertical resolution this link actually carries (1080 for a
     *  1920x1080 or 1920x800 top rendition), when the scraper measured it.
     *  The host lists a title's web links best first by this; links without
     *  it follow, in scraper order. Needs web-links >= 0.11.0. */
    height?: number;
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
    /** Extra request headers the target requires on every playlist and
     *  segment fetch, beyond `referrer`/`userAgent` -- typically `Origin`,
     *  which several CDNs demand alongside the Referer (a browser always
     *  sends both). Only `Origin`, `Accept`, `Accept-Language` and `X-*`
     *  headers are honoured; anything else is dropped by the relay. */
    headers?: Record<string, string>;
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
    /** The best resolution this scraper can ever return, e.g. "480p",
     *  "1080p", "4K" -- free text, shown next to the scraper on the settings
     *  page. Not enforced or parsed: an individual `WebLink.quality` may
     *  still be lower for a given title. Omit if unknown. */
    maxQuality?: string;
    /** How this scraper gets its links. `"fast"` -- plain HTTP, typically
     *  under a few seconds. `"slow"` -- drives a real browser (Playwright/
     *  Chromium) to read a value out of page-side code, typically seconds
     *  to tens of seconds and needing `CHROMIUM_PATH` on the host. Informational
     *  only (shown on the settings page); the host does not currently use it
     *  to schedule or time out a scraper differently. Omit if unknown. */
    fetchMethod?: "fast" | "slow";
    /** Return every link this scraper can find for `query`. An empty array
     *  for "no results", never a throw for "not found" -- reserve throwing
     *  for the target site actually being unreachable/erroring. A result
     *  may set `resolveId` instead of a real `url` -- see `WebLink`. */
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
    /** Only needed by a scraper that sets `resolveId` on some of its
     *  `WebLink`s -- turns that id back into the real, fresh link right
     *  before it is used. Called at most once per play attempt (the host
     *  briefly caches the answer so a single play doesn't re-run this for
     *  every internal fetch of the same link), never by the host at list
     *  time. Return
     *  `null` for "this one's gone" rather than throwing, when that's
     *  distinguishable from the target site being unreachable. */
    resolve?(resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null>;
}
