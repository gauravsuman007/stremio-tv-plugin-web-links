/**
 * The slice of stremio-tv's plugin contract this plugin actually uses,
 * copied in so this repo has no dependency on the stremio-tv repo itself.
 * Kept in sync BY HAND against `src/plugin-types.ts` in stremio-tv --
 * see that file for the authoritative, fully-documented version and for
 * `PLUGIN_API_VERSION`'s versioning rule.
 *
 * This plugin declares no `ownsContentId`/`metaFor`/`streamsFor` -- it
 * never owns a content id. It only implements `extraStreamsFor`, which is
 * asked for EVERY title (addon-owned or not) and lets a plugin offer
 * supplementary stream options without claiming ownership -- exactly the
 * "search web links for whatever title is on screen" shape this plugin is.
 */
export {};
