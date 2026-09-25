import { loadScrapers } from "./registry.mjs";
import { makeVpnAwareFetch } from "./vpn-fetch.mjs";
import { initScraperConfig, scraperEnabled, setScraperEnabled } from "./scraper-config.mjs";
import { forgetGithubSource, importScraperFromGithub, importScraperFromStoredSource, initGithubImport, listGithubSources, rememberGithubSource } from "./github-import.mjs";
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
 * A link into this plugin's own resolve route, built without a `client`
 * (`extraStreamsFor` isn't handed one) -- plugins run in-process with
 * stremio-tv, so a loopback URL back into this same server works fine.
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
    const port = process.env.PORT || "3300";
    const path = resolveKind === "hls" ? "resolve.m3u8" : "resolve";
    return `http://127.0.0.1:${port}/s/${sessionId || "resolve"}/plugin/web-links/${path}?${params.toString()}`;
}
/**
 * Rewrites every relative URI in an HLS playlist to absolute, resolved
 * against `baseUrl` (the real URL the playlist was actually fetched from).
 * Handles plain URI lines (segments, variant playlists) and the `URI="..."`
 * attribute on tag lines (`#EXT-X-MAP`, `#EXT-X-KEY`, ...) -- both would
 * otherwise resolve against whatever URL the CLIENT fetched the rewritten
 * playlist from, not cinejoy's real CDN, and 404.
 */
function rewritePlaylist(text, baseUrl) {
    const absolutize = (ref) => {
        try {
            return new URL(ref, baseUrl).toString();
        }
        catch {
            return ref;
        }
    };
    return text
        .split(/\r?\n/)
        .map((line) => {
        if (!line)
            return line;
        if (line.startsWith("#"))
            return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${absolutize(uri)}"`);
        const trimmed = line.trim();
        return trimmed ? absolutize(trimmed) : line;
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
            version: scraper.version
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
                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error });
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
                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error });
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
                    body: rewritePlaylist(playlist, link.url)
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
        version: "0.3.1",
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};
export default createPlugin;
