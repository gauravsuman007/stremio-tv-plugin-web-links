# Working on stremio-tv-plugin-web-links

## dist/ is built by CI, never locally

stremio-tv's plugin importer (Settings > Plugins > Import from GitHub) reads the compiled `dist/` (`plugin.mjs` + `plugin.json`) from this repo's main branch. There is no build step on the consuming side, so `dist/` has to be committed -- but **only by CI**.

- **Do not run `npm run build` to produce a commit, and do not hand-edit or commit `dist/`.** Commit source only.
- `.github/workflows/ci.yml` typechecks, builds, and on a push to `main` commits any change in `dist/` back as `github-actions[bot]` with `[skip ci]` (`contents: write`). Pull requests only prove the build works.
- So after pushing, `git pull` before your next commit; the bot's commit will be ahead of you.
- `npm run build` locally is fine for trying something out; leave the resulting `dist/` changes uncommitted (`git checkout dist`).
- A change is not live for stremio-tv until that bot commit exists **and** someone presses "Check for updates" on stremio-tv's plugins page. Nothing pulls on its own. Bump the version in `plugin.json` -- the importer only installs a real increase.

## One package may ship several scrapers

A scraper repo's `dist/` is one package (`scraper.json` -> `scrapers/<id>/`, one version), but its `entry` may export several `WebLinkScraper`s: a default export that is an array, or a named `scrapers` array (`unwrapScrapers` in `src/registry.mts`, which also handles the CJS-interop nesting). Each scraper keeps its own `id`, which is what routes `resolve()` and what the sources page lists; the package id only names the directory. A malformed entry is dropped alone. If two scrapers (in one package or across packages) claim the same id, the first loaded wins and the later one is logged and skipped. The importer is unchanged: it installs and version-compares the package as a whole.

## Every installed scraper package can be updated, even one with no recorded source

The scrapers page has an **Update** button per scraper, acting on its *package* (`packageOf` in `registry.mts` maps a loaded scraper to its directory). A successful import writes `<pkg>/.source.json` (`{owner, repo}`) so the button knows where to look. A package copied in by hand, or installed before that file existed, has none, so `updateScraperById` tries every remembered source and then `DEFAULT_SCRAPER_REPOS` (there is no naming convention to infer a scraper repo from), passes the package id as `expectId` so a wrong repository cannot install some other package, and pins the one that matches. "No update available" is `ScraperImportResult.upToDate`, never parsed from the error text.

## The version is written once

`plugin.json` is the only place a plugin's version lives; `plugin.mts` reads it from beside the compiled file, and stremio-tv shows the manifest's version ahead of the code's. A scraper package's version shown on the scrapers page is likewise the package's `scraper.json`, not whatever the scraper reports about itself (`packageVersionOf`). A literal in source is what made a bumped version keep showing the old number.

## Reloading a `.cjs` scraper needs its `require` cache cleared

`loadScrapers` busts ESM caching with `?reload=N`, which does nothing for a CommonJS bundle: `require`'s cache is keyed by path. Without `forgetCachedModules` an Update replaced the files and the running process kept the old code -- the page listed the old version and, worse, ran the old scraper -- until a restart. `test/registry.mjs` loads a `.cjs` package, rewrites it and asserts the second load is the new one.

## Enable, disable and delete a scraper

Each scraper row has **Update**, **Disable/Enable** and **Delete**. There is no "only source configured" lock any more: a plugin with every scraper off simply finds no web links. Delete acts on the whole *package* (`<pluginsDir>/web-links/data/scrapers/<pkg>/`), because a package can hold several scrapers; the confirmation says so, the id is checked against `[a-z0-9-]` before it is joined into a path, and each scraper's off-switch is reset so a later re-import of the same id starts enabled.

## A link can ask the relay for extra request headers

`WebLink.headers` (contract in `src/scraper.mts`) carries request headers beyond `referrer`/`userAgent` -- chiefly `Origin`, which some CDNs require alongside the Referer (they 403 a Referer alone; a browser always sends both). The relay puts them, base64url-encoded JSON, in a `hdr` query parameter next to `ref` on every `variant`/`segment` URL it writes, so each hop fetches with the same headers; `resolve.m3u8` applies them to the first fetch. A link's `userAgent` rides the same way. Only `Origin`, `Accept`, `Accept-Language`, `User-Agent` and `X-*` are honoured (`RELAY_HEADER_ALLOWED`): the relay's URLs are reachable by anything that can reach the plugin, so a link must not be able to set Host, Cookie or Authorization. `test/relay-headers.mjs` runs the real routes against a local upstream that refuses without Origin. Needs web-links >= 0.9.0 for a scraper that sets `headers`; an older host ignores the field.

## A scraper can declare its max resolution and fetch method

`WebLinkScraper.maxQuality` (free text, e.g. `"1080p"`, `"4K"`) and `WebLinkScraper.fetchMethod` (`"fast"` for plain HTTP, `"slow"` for a Playwright/Chromium-driven scraper) are optional metadata a scraper sets once, alongside `id`/`name` -- contract in `src/scraper.mts`. The settings page (`src/pages/scrapers.mts`) shows both next to each scraper's name and version; the host does not otherwise act on them (no scheduling or timeout change). Both are informational only and safe to omit; an older scraper package that predates this field just shows neither badge.

## Web links are listed best resolution first

`WebLink.height` (contract in `src/scraper.mts`) is the vertical resolution a scraper actually measured for a link (from its playlist, not guessed). `extraStreamsFor` sorts a title's web links by it, tallest first; links without it follow in scraper order (the sort is stable). A scraper that resolves cheaply may now resolve during `search()` to set it, keeping `resolveId` so the URL is re-checked at play time rather than trusted from the list -- stremio-tv-plugin-web-scraper does this since 1.20.0. `test/plugin.mjs` checks the order. Needs web-links >= 0.11.0; an older host ignores the field and keeps scraper order.

## The "Web links" column is drawn here, not in stremio-tv

`streamColumn` (plugin API 1.1.0; types in `src/contract.mts`) renders this plugin's column on stremio-tv's "select quality" screen: stremio-tv hands over every stream this plugin offered, each with its `/play` link, and places the `{ heading, html }` returned. Row wording, badges (the measured `webLinkHeight`, carried in `behaviorHints`), order (tallest first) and the VPN line at the top are all here. An older stremio-tv never calls it and draws the rows itself. `test/plugin.mjs` covers the order and markup.

Each row is headed, in bold, by the scraper's site name and the link's `WebLink.server` (`webLinkSite`/`webLinkServer` hints); its last line lists `WebLink.audio` (`webLinkAudio`), "not stated" when a scraper gives none (both fields need >= 0.13.0).

**Search results are cached** (`searchCache` in `src/plugin.mts`, 3h, 10 min for an empty answer, keyed by scraper id and version and the title), so coming back from the player lists the same rows at once and `/play/<index>` points at the same row it did. A placeholder answer (a row with a `resolveId` but no `quality`/`height`, i.e. a resolve still running) is asked again on the next visit, but only for 400ms before the same placeholders are shown. Rows never carry final URLs, so this is safe: playing resolves and re-checks the link.

## Search timeout is a setting

The budget every scraper's `search()` gets for one title is set on the settings page ("Search timeout", 1-60s, default 5s), stored as `searchTimeoutMs` in `scraper-state.json` next to the on/off switches (`src/scraper-config.mts`). It bounds how long the streams list waits for web links; a scraper that isn't done in time returns a placeholder row. `resolve()` at play time has its own, longer budget (`RESOLVE_BUDGET_MS`).
