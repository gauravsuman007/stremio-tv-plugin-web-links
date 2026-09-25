# Why resume/seek isn't part of this plugin

Short answer: stremio-tv's player already owns resume/seek for every
stream source, scraped links included, and this plugin has no way to do it
better.

Resume requires:

- The live `<video>`/hls.js/mpv instance -- something no plugin has access
  to (`src/plugin-types.ts` in stremio-tv is explicit: "No player hook --
  playback stays entirely inside stremio-tv").
- Knowing whether *this specific link* honors an HTTP `Range` request --
  which varies per site, per link, and often per token/session on the
  link itself, not something a scraper contract can generalize.
- Buffering/seek state that only exists once playback has actually
  started.

If this plugin's scraper contract accepted a "resume at this timestamp"
input, every scraper author would have to reason about turning that into
a `Range` header or a `#t=` URL fragment for their specific target site --
duplicated, fragile logic, for a feature stremio-tv's player already
handles uniformly for every source (see `src/progress.ts` and
`src/session.ts` in the stremio-tv repo). A scraped link that doesn't
support ranged requests at all would silently break "resume" in a way the
plugin has no way to detect or communicate.

So: a `WebLink` from a scraper is just a URL (plus display metadata). The
app resumes it the same way it resumes anything else.
