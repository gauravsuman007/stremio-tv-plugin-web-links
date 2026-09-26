import { readFileSync } from "node:fs";
import { loadScrapers, packageOf, packageVersionOf } from "./registry.mjs";
import { makeVpnAwareFetch } from "./vpn-fetch.mjs";
import { initScraperConfig, scraperEnabled, setScraperEnabled } from "./scraper-config.mjs";
import { forgetGithubSource, importScraperFromGithub, importScraperFromStoredSource, updateScraperById, initGithubImport, listGithubSources, rememberGithubSource } from "./github-import.mjs";
import { importSummary, scrapersPage } from "./pages/scrapers.mjs";
const PLUGIN_ID = "web-links";
function parseQuery(type, id, title) {
    const [, seasonStr, episodeStr] = id.split(":");
    const season = seasonStr ? Number(seasonStr) : undefined;
    const episode = episodeStr ? Number(episodeStr) : undefined;
    return { type, id, title, season, episode };
}
/** One search budget shared across every scraper for a single title, so a
 *  slow or hung scraper can't stall the whole `extraStreamsFor` call --
 *  and, in turn, the user's "select quality" screen. */
const SEARCH_BUDGET_MS = 15000;
async function runScraper(scraper, query, fetchImpl, proxyUrl) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve([]), SEARCH_BUDGET_MS));
    const run = scraper.search(query, { fetch: fetchImpl, budgetMs: SEARCH_BUDGET_MS, proxyUrl }).catch((cause) => {
        console.warn(`[web-links] scraper ${scraper.id} failed:`, cause);
        return [];
    });
    return Promise.race([run, timeout]);
}
/**
 * A resolved link is cached briefly, keyed by exactly what produced it, so
 * ONE play attempt -- which fetches the same URL several times over (a
 * range-probe, an ffprobe, then the actual relay) -- triggers the scraper's
 * (possibly browser-driven) `resolve()` once, not three-plus times. Short
 * enough that a LATER, separate play click always gets a freshly resolved
 * link rather than reusing a token that may have already expired.
 */
const RESOLVE_TTL_MS = 45_000;
const resolveCache = new Map();
function trimResolveCache() {
    const cutoff = Date.now() - RESOLVE_TTL_MS * 4;
    for (const [key, entry] of resolveCache) {
        if (entry.at < cutoff)
            resolveCache.delete(key);
    }
}
/**
 * The host+port this same server is reachable at, for a link back into
 * itself. NOT `127.0.0.1` -- that was tried and is wrong for exactly the
 * requests this URL exists for: a non-live "direct" source is re-fetched
 * not only by THIS process (`/direct/`'s own relay, which really is
 * in-process) but also by the SEPARATE streaming-server container, for
 * `probe?url=` (codec badges) and, if this plugin's own playlist is ever
 * judged to need repackaging, `hlsv2`'s `mediaURL` fetch -- and `127.0.0.1`
 * from INSIDE THAT container is that container's own loopback, nothing
 * stremio-tv is listening on. Measured: every such cross-container fetch
 * silently failed, which surfaced as no codec badges and a stream that
 * played once, then "converted", then never played again. The container's
 * own name (`stremio-tv`, `docker-compose.yml`'s `container_name`) is what
 * every other cross-container address in that compose file already uses --
 * `SELF_HOST` overrides it for a deployment named differently.
 */
function selfOrigin() {
    const host = process.env.SELF_HOST || "stremio-tv";
    const port = process.env.PORT || "3300";
    return `http://${host}:${port}`;
}
/**
 * A link into this plugin's own resolve route, built without a `client`
 * (`extraStreamsFor` isn't handed one) -- plugins run in-process with
 * stremio-tv, but that alone isn't enough, see `selfOrigin()`.
 * `session.id` is included so the resolve handler can VPN-route the same
 * way `extraStreamsFor` did; when it's missing, stremio-tv mints a fresh
 * session and redirects to it, path and query preserved, so the route
 * still resolves correctly either way.
 *
 * Two different paths, chosen by `resolveKind` (see `scraper.mts`):
 * `/resolve` 303s straight to the resolved URL, for a plain file. An HLS
 * playlist needs `/resolve.m3u8` instead -- see that route's own doc for
 * why a redirect can't be used there. stremio-tv's own relay asserts a
 * response's content-type from THIS URL's extension, never from what the
 * resolve route itself returns (see stremio-tv's `proxy.ts`), which is the
 * other reason the path has to actually end in `.m3u8`.
 */
function resolveEndpoint(scraperId, resolveId, resolveKind, query, sessionId) {
    const params = new URLSearchParams({ scraper: scraperId, rid: resolveId, type: query.type, id: query.id, title: query.title });
    if (query.season != null)
        params.set("season", String(query.season));
    if (query.episode != null)
        params.set("episode", String(query.episode));
    const path = resolveKind === "hls" ? "resolve.m3u8" : "resolve";
    return `${selfOrigin()}/s/${sessionId || "resolve"}/plugin/web-links/${path}?${params.toString()}`;
}
/**
 * A link into this plugin's own `/plugin/web-links/segment` route, standing
 * in for a real relative URI (a segment, an init section, a variant
 * playlist) inside a rewritten HLS playlist -- see `rewritePlaylist`.
 *
 * WHY THIS PROXIES BYTES RATHER THAN POINTING AT cinejoy DIRECTLY
 * -------------------------------------------------------------------
 * A first version rewrote relative URIs to cinejoy's own absolute URLs.
 * That played once, briefly, then failed: stremio-tv's own player already
 * carries the lesson for exactly this shape of source (see its `index.ts`,
 * the note above the live-TV `direct` field) -- measured across dozens of
 * live sources, NONE send `access-control-allow-origin`, so hls.js (which
 * fetches segments with XHR, unlike a native HLS `<video>`) cannot read a
 * cross-origin response at all and reports a decode/format error the
 * moment it actually tries. Relaying every segment back through here, the
 * same way stremio-tv's own `/hls/` relay does for a live channel, keeps
 * every fetch same-origin. It also means a web link's segment bytes
 * actually go through the household tunnel when one is configured --
 * without this, only the scraper's OWN search-time calls did, and a viewer
 * had no way to tell the difference from the player.
 *
 * TRULY RELATIVE -- NEITHER `selfOrigin()` NOR A LEADING SLASH.
 * -------------------------------------------------------------------
 * `resolveEndpoint()` bakes `selfOrigin()` in because it is a fresh URL
 * with no base of its own: whoever holds it (stremio-tv's own relay,
 * ffprobe on the separate streaming-server container) has to be able to
 * fetch it cold. This URL is different -- it only ever appears INSIDE a
 * playlist `rewritePlaylist` has already produced, and every consumer of
 * that playlist (the browser's hls.js, ffprobe, ffmpeg's remux) resolves a
 * relative reference against the URL IT fetched the playlist from, not
 * against anything baked into the string. Making this one absolute
 * (`http://stremio-tv:3300/...`) looked harmless and was not: it hard-codes
 * the CONTAINER's own hostname, which only Docker's internal DNS can
 * resolve. ffprobe and ffmpeg run where that resolves and never noticed;
 * the television's own browser does not run there, so every single
 * segment fetch failed outright (hls.js: `fragLoadError HTTP Error 0` on
 * EVERY fragment) and playback fell through to a server-side conversion
 * every time, which is a genuinely different request path and so was
 * never affected.
 *
 * A root-relative path (a leading `/`) is not enough either: stremio-tv
 * itself sits behind a reverse proxy that mounts it at a path prefix
 * (`/app/stremio-tv`, stripped before it ever reaches this process -- see
 * `client.ts`), so a browser resolving a root-relative URI drops that
 * prefix and asks the proxy for a path it does not route. This route and
 * `resolve.m3u8` live in the same directory
 * (`plugin/web-links/resolve.m3u8` next to `plugin/web-links/segment`), so
 * a BARE relative reference -- no leading slash at all -- resolves
 * against whatever the playlist's own URL was, prefix included, for every
 * fetcher on every network without this code ever having to know what
 * that prefix is.
 */
function segmentEndpoint(absoluteUrl, referrer) {
    const params = new URLSearchParams({ u: Buffer.from(absoluteUrl, "utf8").toString("base64url") });
    if (referrer)
        params.set("ref", Buffer.from(referrer, "utf8").toString("base64url"));
    return `segment?${params.toString()}`;
}
/**
 * The same idea as `segmentEndpoint`, for a MASTER playlist's own variant
 * lines -- each one names another PLAYLIST (a `.m3u8`, one per rendition),
 * not a media segment, and needs the same recursive treatment
 * `rewritePlaylist` gives the top-level one: its own relative segment/init
 * references have to resolve correctly too, which only happens if this
 * plugin fetches and rewrites it itself rather than handing the browser a
 * bare proxied byte-stream. See the `/plugin/web-links/variant` route.
 */
function variantEndpoint(absoluteUrl, referrer) {
    const params = new URLSearchParams({ u: Buffer.from(absoluteUrl, "utf8").toString("base64url") });
    if (referrer)
        params.set("ref", Buffer.from(referrer, "utf8").toString("base64url"));
    return `variant?${params.toString()}`;
}
/**
 * Rewrites every relative URI in an HLS playlist into a same-origin link,
 * resolved against `baseUrl` (the real URL the playlist was actually
 * fetched from) before being wrapped. Handles plain URI lines (segments,
 * or a MASTER's variant playlists) and the `URI="..."` attribute on tag
 * lines (`#EXT-X-MAP`, `#EXT-X-KEY`, ...) -- all three are a real fetch a
 * player will make, and all three need proxying for the same reason.
 *
 * A MASTER PLAYLIST'S OWN VARIANT LINES ARE NOT SEGMENTS.
 * A line straight after `#EXT-X-STREAM-INF` names another PLAYLIST, one
 * per resolution -- routing it through `segmentEndpoint` would hand the
 * browser that nested playlist's raw bytes with ITS OWN relative
 * references left unrewritten and therefore unreachable. Route it through
 * `variantEndpoint` instead, which fetches and rewrites it the same way,
 * recursively -- see the `/plugin/web-links/variant` route below.
 */
function rewritePlaylist(text, baseUrl, referrer) {
    const proxied = (ref, variant) => {
        try {
            const absolute = new URL(ref, baseUrl).toString();
            return variant ? variantEndpoint(absolute, referrer) : segmentEndpoint(absolute, referrer);
        }
        catch {
            return ref;
        }
    };
    let nextIsVariant = false;
    return text
        .split(/\r?\n/)
        .map((line) => {
        if (!line)
            return line;
        if (line.startsWith("#")) {
            const rewritten = line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxied(uri, false)}"`);
            nextIsVariant = line.startsWith("#EXT-X-STREAM-INF");
            return rewritten;
        }
        const trimmed = line.trim();
        const variant = nextIsVariant;
        nextIsVariant = false;
        return trimmed ? proxied(trimmed, variant) : line;
    })
        .join("\n");
}
/** Shared by both resolve routes: cache lookup, then the scraper's actual
 *  (possibly browser-driven) `resolve()`, cached again on the way out. */
async function resolveWebLink(host, scrapers, scraperId, rid, query, ctx) {
    const scraper = scrapers.find((s) => s.id === scraperId);
    if (!scraper?.resolve)
        return null;
    const cacheKey = `${scraperId}:${rid}:${query.id}:${query.season ?? ""}:${query.episode ?? ""}`;
    const cached = resolveCache.get(cacheKey);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS)
        return cached.link;
    const { fetch: fetchImpl, proxyUrl } = await makeVpnAwareFetch(host, PLUGIN_ID, ctx.client.session);
    let link;
    try {
        link = await scraper.resolve(rid, query, { fetch: fetchImpl, budgetMs: SEARCH_BUDGET_MS, proxyUrl });
    }
    catch (cause) {
        console.warn(`[web-links] resolve failed for ${scraperId}/${rid}:`, cause);
        link = null;
    }
    trimResolveCache();
    resolveCache.set(cacheKey, { at: Date.now(), link });
    return link;
}
function parseResolveParams(ctx) {
    const query = {
        type: String(ctx.query.get("type") || ""),
        id: String(ctx.query.get("id") || ""),
        title: String(ctx.query.get("title") || "")
    };
    const season = ctx.query.get("season");
    const episode = ctx.query.get("episode");
    if (season)
        query.season = Number(season);
    if (episode)
        query.episode = Number(episode);
    return { scraperId: String(ctx.query.get("scraper") || ""), rid: String(ctx.query.get("rid") || ""), query };
}
function redirect(client, to) {
    const link = client.link;
    return { status: 303, headers: { location: link(to) }, body: "" };
}
const createPlugin = (host, configDir) => {
    initScraperConfig(configDir);
    initGithubImport(configDir);
    let scrapersPromise = loadScrapers(configDir);
    async function sendScrapersPage(ctx, note) {
        const all = await scrapersPromise;
        const rows = all.map((scraper) => ({
            id: scraper.id,
            name: scraper.name,
            enabled: scraperEnabled(scraper.id),
            sole: all.length === 1,
            version: packageVersionOf.get(scraper) ?? scraper.version,
            packageId: packageOf.get(scraper)
        }));
        const githubSources = listGithubSources();
        const signedIn = Boolean(ctx.client.session?.authKey);
        const capability = await host.requestVpnCapability(PLUGIN_ID, ctx.client.session);
        const link = ctx.client.link;
        return {
            body: scrapersPage(host, ctx.client, signedIn, rows, githubSources, note, capability.status ?? null, link),
            headers: { "content-type": "text/html" }
        };
    }
    const routes = [
        {
            method: "GET",
            path: "/plugin/web-links",
            async handle(ctx) {
                if (ctx.query.has("reload")) {
                    scrapersPromise = loadScrapers(configDir);
                    await scrapersPromise;
                    return redirect(ctx.client, "/plugin/web-links");
                }
                const all = await scrapersPromise;
                const toOn = String(ctx.query.get("on") || "");
                const toOff = String(ctx.query.get("off") || "");
                const asked = toOn || toOff;
                if (asked && all.some((s) => s.id === asked)) {
                    setScraperEnabled(asked, Boolean(toOn));
                    return redirect(ctx.client, "/plugin/web-links");
                }
                return sendScrapersPage(ctx, null);
            }
        },
        {
            method: "POST",
            path: "/plugin/web-links/github-import",
            async handle(ctx) {
                const combo = String(ctx.form.get("repo") || "").trim();
                const slash = combo.indexOf("/");
                if (slash < 1 || slash === combo.length - 1) {
                    return sendScrapersPage(ctx, { text: `"${combo}" is not an "owner/repo" address.`, ok: false });
                }
                const owner = combo.slice(0, slash);
                const repo = combo.slice(slash + 1);
                const token = String(ctx.form.get("token") || "").trim();
                const source = rememberGithubSource(owner, repo, token);
                try {
                    const result = await importScraperFromGithub(configDir, owner, repo, source.token);
                    if (result.updated)
                        scrapersPromise = loadScrapers(configDir);
                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error || Boolean(result.upToDate) });
                }
                catch (cause) {
                    return sendScrapersPage(ctx, {
                        text: `Import from ${owner}/${repo} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        ok: false
                    });
                }
            }
        },
        {
            method: "POST",
            path: "/plugin/web-links/github-recheck",
            async handle(ctx) {
                const owner = String(ctx.form.get("owner") || "");
                const repo = String(ctx.form.get("repo") || "");
                try {
                    const result = await importScraperFromStoredSource(configDir, owner, repo);
                    if (result.updated)
                        scrapersPromise = loadScrapers(configDir);
                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error || Boolean(result.upToDate) });
                }
                catch (cause) {
                    return sendScrapersPage(ctx, {
                        text: `Check for updates on ${owner}/${repo} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                        ok: false
                    });
                }
            }
        },
        {
            method: "POST",
            path: "/plugin/web-links/scraper-update",
            async handle(ctx) {
                const id = String(ctx.form.get("id") || "");
                try {
                    const result = await updateScraperById(configDir, id);
                    if (result.updated)
                        scrapersPromise = loadScrapers(configDir);
                    return sendScrapersPage(ctx, {
                        text: result.updated || result.upToDate ? importSummary({ ...result, id }) : `${id}: ${result.error || "update failed"}`,
                        ok: result.updated || Boolean(result.upToDate)
                    });
                }
                catch (cause) {
                    return sendScrapersPage(ctx, { text: `${id}: ${cause instanceof Error ? cause.message : String(cause)}`, ok: false });
                }
            }
        },
        {
            method: "POST",
            path: "/plugin/web-links/github-forget",
            async handle(ctx) {
                forgetGithubSource(String(ctx.form.get("owner") || ""), String(ctx.form.get("repo") || ""));
                return redirect(ctx.client, "/plugin/web-links");
            }
        },
        {
            method: "GET",
            path: "/plugin/web-links/resolve",
            async handle(ctx) {
                const { scraperId, rid, query } = parseResolveParams(ctx);
                const all = await scrapersPromise;
                const link = await resolveWebLink(host, all, scraperId, rid, query, ctx);
                if (!link)
                    return { status: 502, body: "could not resolve this link right now" };
                return { status: 303, headers: { location: link.url }, body: "" };
            }
        },
        {
            method: "GET",
            path: "/plugin/web-links/resolve.m3u8",
            async handle(ctx) {
                const { scraperId, rid, query } = parseResolveParams(ctx);
                const all = await scrapersPromise;
                const link = await resolveWebLink(host, all, scraperId, rid, query, ctx);
                if (!link)
                    return { status: 502, body: "could not resolve this link right now" };
                const { fetch: fetchImpl } = await makeVpnAwareFetch(host, PLUGIN_ID, ctx.client.session);
                let playlist;
                try {
                    const upstream = await fetchImpl(link.url, {
                        headers: {
                            ...(link.referrer ? { Referer: link.referrer } : {}),
                            ...(link.userAgent ? { "User-Agent": link.userAgent } : {})
                        }
                    });
                    if (!upstream.ok)
                        return { status: 502, body: `upstream playlist fetch failed (${upstream.status})` };
                    playlist = await upstream.text();
                }
                catch (cause) {
                    console.warn(`[web-links] could not fetch playlist for ${scraperId}/${rid}:`, cause);
                    return { status: 502, body: "could not fetch the playlist" };
                }
                return {
                    status: 200,
                    headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
                    body: rewritePlaylist(playlist, link.url, link.referrer)
                };
            }
        },
        {
            method: "GET",
            path: "/plugin/web-links/segment",
            async handle(ctx) {
                const encodedUrl = String(ctx.query.get("u") || "");
                let target;
                try {
                    target = Buffer.from(encodedUrl, "base64url").toString("utf8");
                }
                catch {
                    return { status: 400, body: "bad segment url" };
                }
                if (!/^https?:\/\//.test(target))
                    return { status: 400, body: "bad segment url" };
                const encodedRef = String(ctx.query.get("ref") || "");
                const referrer = encodedRef ? Buffer.from(encodedRef, "base64url").toString("utf8") : undefined;
                const { fetch: fetchImpl } = await makeVpnAwareFetch(host, PLUGIN_ID, ctx.client.session);
                const range = ctx.headers.range;
                try {
                    const upstream = await fetchImpl(target, {
                        headers: {
                            ...(referrer ? { Referer: referrer } : {}),
                            ...(typeof range === "string" ? { Range: range } : {})
                        }
                    });
                    const buffer = Buffer.from(await upstream.arrayBuffer());
                    const headers = {
                        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
                        "cache-control": "no-store",
                        "accept-ranges": "bytes"
                    };
                    const contentRange = upstream.headers.get("content-range");
                    if (contentRange)
                        headers["content-range"] = contentRange;
                    return { status: upstream.status, headers, body: buffer };
                }
                catch (cause) {
                    console.warn(`[web-links] segment fetch failed for ${target}:`, cause);
                    return { status: 502, body: "could not fetch segment" };
                }
            }
        },
        {
            /*
                A MASTER PLAYLIST'S OWN VARIANT, FETCHED AND REWRITTEN THE
                SAME WAY THE TOP-LEVEL PLAYLIST WAS.

                Reached only from a `variantEndpoint()` link inside a
                rewritten master (see `rewritePlaylist`) -- never handed out
                directly. Sibling of `/plugin/web-links/segment` in the same
                directory, on purpose: a relative segment reference INSIDE
                the rewritten body below resolves against THIS route's own
                URL, landing back on `segment` correctly without either
                route needing to know the other's shape.
            */
            method: "GET",
            path: "/plugin/web-links/variant",
            async handle(ctx) {
                const encodedUrl = String(ctx.query.get("u") || "");
                let target;
                try {
                    target = Buffer.from(encodedUrl, "base64url").toString("utf8");
                }
                catch {
                    return { status: 400, body: "bad variant url" };
                }
                if (!/^https?:\/\//.test(target))
                    return { status: 400, body: "bad variant url" };
                const encodedRef = String(ctx.query.get("ref") || "");
                const referrer = encodedRef ? Buffer.from(encodedRef, "base64url").toString("utf8") : undefined;
                const { fetch: fetchImpl } = await makeVpnAwareFetch(host, PLUGIN_ID, ctx.client.session);
                let playlist;
                try {
                    const upstream = await fetchImpl(target, { headers: referrer ? { Referer: referrer } : {} });
                    if (!upstream.ok)
                        return { status: 502, body: `upstream variant fetch failed (${upstream.status})` };
                    playlist = await upstream.text();
                }
                catch (cause) {
                    console.warn(`[web-links] could not fetch variant ${target}:`, cause);
                    return { status: 502, body: "could not fetch the variant" };
                }
                return {
                    status: 200,
                    headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
                    body: rewritePlaylist(playlist, target, referrer)
                };
            }
        }
    ];
    async function extraStreamsFor(type, id, session) {
        const all = await scrapersPromise;
        const enabled = all.filter((s) => scraperEnabled(s.id));
        if (enabled.length === 0)
            return [];
        const { fetch: fetchImpl, proxyUrl } = await makeVpnAwareFetch(host, PLUGIN_ID, session);
        // Title isn't handed to a plugin's extraStreamsFor today -- fall
        // back to the raw id as the search term until stremio-tv threads
        // one through; a scraper that needs richer metadata can fetch it
        // itself via `id`.
        const query = parseQuery(type, id, id);
        const sessionId = session?.id;
        const perScraper = await Promise.all(enabled.map(async (scraper) => ({ scraper, links: await runScraper(scraper, query, fetchImpl, proxyUrl) })));
        return perScraper.flatMap(({ scraper, links }) => {
            return links.map((link) => ({
                value: {
                    url: link.resolveId
                        ? resolveEndpoint(scraper.id, link.resolveId, link.resolveKind, query, sessionId)
                        : link.url,
                    name: link.quality,
                    title: link.title,
                    description: [link.size, ...(link.labels ?? [])].filter(Boolean).join(" · ") || undefined
                }
            }));
        });
    }
    return {
        id: PLUGIN_ID,
        name: "Web Links",
        version: pluginVersion(),
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};
/** Read from `plugin.json` beside the compiled file, the one place the
 *  version is written, so the code can never claim a different one. */
function pluginVersion() {
    try {
        return JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8")).version;
    }
    catch {
        return undefined;
    }
}
export default createPlugin;
