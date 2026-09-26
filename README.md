# stremio-tv-plugin-web-links

A [stremio-tv](https://github.com/gauravsuman007) plugin that searches
HTTP-hosted web links for whatever title you're playing, offering them in
their own column alongside torrent/debrid streams on the "select quality"
screen. It ships with **no scrapers** -- it's a host for scrapers you drop
in yourself. See
[`templates/scraper-template.mts`](templates/scraper-template.mts) to write
one, and [`stremio-tv-plugin-web-scraper`](https://github.com/gauravsuman007/stremio-tv-plugin-web-scraper)
for a real, working one (cinejoy.pk).

## How it fits into stremio-tv

This plugin implements `extraStreamsFor`, the plugin hook that offers
*supplementary* streams for a title without claiming ownership of it (see
`src/plugin-types.ts` in the stremio-tv repo). It does not own any content
ids, has no meta/catalogue of its own, and never touches playback.

- **Scrapers** live in this plugin's protected `data/scrapers/<id>/`
  folders -- each one a small package (`scraper.json` manifest + whatever
  its `entry` needs) matching the `WebLinkScraper` contract in
  [`src/scraper.mts`](src/scraper.mts). That folder survives every plugin
  reinstall/update -- only the plugin's own `code/` gets replaced. Manage
  them from the settings page this plugin links to (`/plugin/web-links`,
  reachable from stremio-tv's Settings -> Plugins page) -- import from
  GitHub, check for updates, or switch one off.
- **VPN**: every scraper's plain HTTP calls go through `ctx.fetch`, which
  this plugin resolves once per search via `host.requestVpnCapability` --
  routed through the household tunnel when one is configured, plain
  `fetch` otherwise. A scraper that drives its own browser/socket layer
  (see the `cinejoy` scraper) also gets the raw proxy address as
  `ctx.proxyUrl`, since a whole external process's traffic can't be routed
  through `ctx.fetch`. A scraper never sees VPN config beyond that and
  never has to ask.
- **Resume/seek**: not handled here, on purpose -- see
  [`docs/RESUME.md`](docs/RESUME.md).

## Build

```bash
npm install
npm run build
npm test
```

Produces a `dist/` tree (`plugin.mjs`, `plugin.json`, and sibling modules),
committed to `main` -- stremio-tv's plugin importer reads it straight from
GitHub, no build step on that side. CI (`.github/workflows/ci.yml`) fails
the build if `dist/` isn't exactly what a fresh build produces.

## Installing it on a stremio-tv deployment

From stremio-tv's Settings -> Plugins page, "Import from GitHub" with
`gauravsuman007/stremio-tv-plugin-web-links`. From then on its own settings
page (the gear next to "Web Links" in the Loaded list) is where scrapers get
imported and managed.

## Adding a scraper

1. Copy [`templates/scraper-template.mts`](templates/scraper-template.mts).
2. Implement `search(query, ctx)` for your target site, using `ctx.fetch`
   for every plain HTTP request (and `ctx.proxyUrl` for anything else that
   opens its own connections).
3. Compile it (the template's header has the exact `tsc` invocation) and
   write a `scraper.json` (`{ "id", "entry", "version"? }`) alongside it. The entry may default-export one scraper or an array of them (or a named `scrapers` array); `id` names the package, each scraper keeps its own id.
4. Either publish both under a repo's `dist/` and use "Import from GitHub"
   on the plugin's settings page, or copy the folder by hand to
   `<pluginsDir>/web-links/data/scrapers/<id>/` and hit "Reload sources".
