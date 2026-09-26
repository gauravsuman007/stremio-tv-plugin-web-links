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
