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
export {};
