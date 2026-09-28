/**
 * The slice of stremio-tv's plugin contract this plugin actually uses,
 * copied in so this repo has no dependency on the stremio-tv repo itself.
 * Kept in sync BY HAND against the authoritative version:
 * https://github.com/gauravsuman007/stremio-tv/blob/main/src/plugin-types.ts
 * (also `src/plugin-types.ts` in a local checkout of that repo) -- see
 * that file for the fully-documented version, `PLUGIN_API_VERSION`'s
 * versioning rule, and `plugins/registry.json`, which pins the
 * `apiVersion`/capabilities this repo is built and load-tested against in
 * stremio-tv's CI.
 *
 * This plugin declares no `ownsContentId`/`metaFor`/`streamsFor` -- it
 * never owns a content id. It only implements `extraStreamsFor`, which is
 * asked for EVERY title (addon-owned or not) and lets a plugin offer
 * supplementary stream options without claiming ownership -- exactly the
 * "search web links for whatever title is on screen" shape this plugin is.
 */
export {};
