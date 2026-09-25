# stremio-tv-plugin-web-links

A [stremio-tv](https://github.com/gauravsuman007) plugin that searches
HTTP-hosted web links for whatever title you're playing, offering them
alongside torrent/debrid streams on the "select quality" screen. It ships
with **no scrapers** -- it's a host for scrapers you drop in yourself. See
[`templates/scraper-template.mts`](templates/scraper-template.mts) to write
one.

## How it fits into stremio-tv

This plugin implements `extraStreamsFor`, the plugin hook that offers
*supplementary* streams for a title without claiming ownership of it (see
`src/plugin-types.ts` in the stremio-tv repo). It does not own any content
ids, has no meta/catalogue of its own, and never touches playback.

- **Scrapers** live in this plugin's protected `data/scrapers/` folder
  (compiled `.mjs` files, one default export per file matching the
  `WebLinkScraper` contract in [`src/scraper.mts`](src/scraper.mts)).
  That folder survives every plugin reinstall/update -- only the plugin's
  own `code/` gets replaced.
- **VPN**: every scraper's HTTP calls go through `ctx.fetch`, which this
  plugin resolves once per search via `host.requestVpnCapability` --
  routed through the household tunnel when one is configured, plain
  `fetch` otherwise. A scraper never sees VPN config and never has to ask.
- **Resume/seek**: not handled here, on purpose -- see
  [`docs/RESUME.md`](docs/RESUME.md).

## Build

```bash
npm install
npm run build
```

Produces a `dist/` tree (`plugin.mjs` plus its sibling modules). Sync the
whole tree into `<pluginsDir>/web-links/code/` on the stremio-tv host, the
same way the `live-tv` plugin in `plugins/registry.json` is installed.

## Adding a scraper

1. Copy [`templates/scraper-template.mts`](templates/scraper-template.mts).
2. Implement `search(query, ctx)` for your target site, using `ctx.fetch`
   for every request.
3. Compile it (the template's header has the exact `tsc` invocation) and
   drop the `.mjs` output into `<pluginsDir>/web-links/data/scrapers/`.
4. Hit `/plugin/web-links/reload` (or restart stremio-tv) to pick it up.
