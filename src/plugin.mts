import type { PluginFactory, PluginHost, PluginRoute, PluginRouteContext, ExtraStream, VpnStatus } from "./contract.mjs";
import type { WebLink, WebLinkQuery, WebLinkScraper } from "./scraper.mjs";
import { loadScrapers } from "./registry.mjs";
import { makeVpnAwareFetch } from "./vpn-fetch.mjs";
import { initScraperConfig, scraperEnabled, setScraperEnabled } from "./scraper-config.mjs";
import {
    forgetGithubSource,
    importScraperFromGithub,
    importScraperFromStoredSource,
    initGithubImport,
    listGithubSources,
    rememberGithubSource
} from "./github-import.mjs";
import { importSummary, scrapersPage, type GithubSourceRow, type ScraperRow } from "./pages/scrapers.mjs";

const PLUGIN_ID = "web-links";

function parseQuery(type: string, id: string, title: string): WebLinkQuery {
    const [, seasonStr, episodeStr] = id.split(":");
    const season = seasonStr ? Number(seasonStr) : undefined;
    const episode = episodeStr ? Number(episodeStr) : undefined;
    return { type, id, title, season, episode };
}

/** One search budget shared across every scraper for a single title, so a
 *  slow or hung scraper can't stall the whole `extraStreamsFor` call --
 *  and, in turn, the user's "select quality" screen. */
const SEARCH_BUDGET_MS = 15000;

async function runScraper(
    scraper: WebLinkScraper,
    query: WebLinkQuery,
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    proxyUrl: string | undefined
) {
    const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), SEARCH_BUDGET_MS));
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
const resolveCache = new Map<string, { at: number; link: WebLink | null }>();

function trimResolveCache() {
    const cutoff = Date.now() - RESOLVE_TTL_MS * 4;
    for (const [key, entry] of resolveCache) {
        if (entry.at < cutoff) resolveCache.delete(key);
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
function selfOrigin(): string {
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
function resolveEndpoint(
    scraperId: string,
    resolveId: string,
    resolveKind: "file" | "hls" | undefined,
    query: WebLinkQuery,
    sessionId: string | undefined
): string {
    const params = new URLSearchParams({ scraper: scraperId, rid: resolveId, type: query.type, id: query.id, title: query.title });
    if (query.season != null) params.set("season", String(query.season));
    if (query.episode != null) params.set("episode", String(query.episode));
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
 */
function segmentEndpoint(absoluteUrl: string, referrer: string | undefined, sessionId: string | undefined): string {
    const params = new URLSearchParams({ u: Buffer.from(absoluteUrl, "utf8").toString("base64url") });
    if (referrer) params.set("ref", Buffer.from(referrer, "utf8").toString("base64url"));
    return `${selfOrigin()}/s/${sessionId || "resolve"}/plugin/web-links/segment?${params.toString()}`;
}

/**
 * Rewrites every relative URI in an HLS playlist into a same-origin
 * `segmentEndpoint()` link, resolved against `baseUrl` (the real URL the
 * playlist was actually fetched from) before being wrapped. Handles plain
 * URI lines (segments, variant playlists) and the `URI="..."` attribute on
 * tag lines (`#EXT-X-MAP`, `#EXT-X-KEY`, ...) -- both are a real fetch a
 * player will make, and both need proxying for the same reason.
 */
function rewritePlaylist(text: string, baseUrl: string, referrer: string | undefined, sessionId: string | undefined): string {
    const proxied = (ref: string): string => {
        try {
            return segmentEndpoint(new URL(ref, baseUrl).toString(), referrer, sessionId);
        } catch {
            return ref;
        }
    };

    return text
        .split(/\r?\n/)
        .map((line) => {
            if (!line) return line;
            if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxied(uri)}"`);
            const trimmed = line.trim();
            return trimmed ? proxied(trimmed) : line;
        })
        .join("\n");
}

interface ResolveParams {
    scraperId: string;
    rid: string;
    query: WebLinkQuery;
}

/** Shared by both resolve routes: cache lookup, then the scraper's actual
 *  (possibly browser-driven) `resolve()`, cached again on the way out. */
async function resolveWebLink(
    host: PluginHost,
    scrapers: WebLinkScraper[],
    scraperId: string,
    rid: string,
    query: WebLinkQuery,
    ctx: PluginRouteContext
): Promise<WebLink | null> {
    const scraper = scrapers.find((s) => s.id === scraperId);
    if (!scraper?.resolve) return null;

    const cacheKey = `${scraperId}:${rid}:${query.id}:${query.season ?? ""}:${query.episode ?? ""}`;
    const cached = resolveCache.get(cacheKey);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.link;

    const { fetch: fetchImpl, proxyUrl } = await makeVpnAwareFetch(host, PLUGIN_ID, (ctx.client as { session?: unknown }).session);
    let link: WebLink | null;
    try {
        link = await scraper.resolve(rid, query, { fetch: fetchImpl, budgetMs: SEARCH_BUDGET_MS, proxyUrl });
    } catch (cause) {
        console.warn(`[web-links] resolve failed for ${scraperId}/${rid}:`, cause);
        link = null;
    }
    trimResolveCache();
    resolveCache.set(cacheKey, { at: Date.now(), link });
    return link;
}

function parseResolveParams(ctx: PluginRouteContext): ResolveParams {
    const query: WebLinkQuery = {
        type: String(ctx.query.get("type") || ""),
        id: String(ctx.query.get("id") || ""),
        title: String(ctx.query.get("title") || "")
    };
    const season = ctx.query.get("season");
    const episode = ctx.query.get("episode");
    if (season) query.season = Number(season);
    if (episode) query.episode = Number(episode);

    return { scraperId: String(ctx.query.get("scraper") || ""), rid: String(ctx.query.get("rid") || ""), query };
}

function redirect(client: PluginRouteContext["client"], to: string) {
    const link = (client as { link(path: string): string }).link;
    return { status: 303, headers: { location: link(to) }, body: "" };
}

const createPlugin: PluginFactory = (host, configDir) => {
    initScraperConfig(configDir);
    initGithubImport(configDir);

    let scrapersPromise = loadScrapers(configDir);

    async function sendScrapersPage(ctx: PluginRouteContext, note: { text: string; ok: boolean } | null) {
        const all = await scrapersPromise;
        const rows: ScraperRow[] = all.map((scraper) => ({
            id: scraper.id,
            name: scraper.name,
            enabled: scraperEnabled(scraper.id),
            sole: all.length === 1,
            version: scraper.version
        }));
        const githubSources: GithubSourceRow[] = listGithubSources();
        const signedIn = Boolean((ctx.client as { session?: { authKey?: string } }).session?.authKey);
        const capability = await host.requestVpnCapability(PLUGIN_ID, (ctx.client as { session?: unknown }).session);
        const link = (ctx.client as { link(path: string): string }).link;

        return {
            body: scrapersPage(host, ctx.client, signedIn, rows, githubSources, note, (capability.status as VpnStatus | null) ?? null, link),
            headers: { "content-type": "text/html" }
        };
    }

    const routes: PluginRoute[] = [
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

                    if (result.updated) scrapersPromise = loadScrapers(configDir);

                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error });
                } catch (cause) {
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

                    if (result.updated) scrapersPromise = loadScrapers(configDir);

                    return sendScrapersPage(ctx, { text: importSummary(result), ok: !result.error });
                } catch (cause) {
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

                if (!link) return { status: 502, body: "could not resolve this link right now" };

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

                if (!link) return { status: 502, body: "could not resolve this link right now" };

                const { fetch: fetchImpl } = await makeVpnAwareFetch(host, PLUGIN_ID, (ctx.client as { session?: unknown }).session);

                let playlist: string;
                try {
                    const upstream = await fetchImpl(link.url, {
                        headers: {
                            ...(link.referrer ? { Referer: link.referrer } : {}),
                            ...(link.userAgent ? { "User-Agent": link.userAgent } : {})
                        }
                    });
                    if (!upstream.ok) return { status: 502, body: `upstream playlist fetch failed (${upstream.status})` };
                    playlist = await upstream.text();
                } catch (cause) {
                    console.warn(`[web-links] could not fetch playlist for ${scraperId}/${rid}:`, cause);
                    return { status: 502, body: "could not fetch the playlist" };
                }

                const sessionId = (ctx.client as { session?: { id?: string } }).session?.id;

                return {
                    status: 200,
                    headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
                    body: rewritePlaylist(playlist, link.url, link.referrer, sessionId)
                };
            }
        },
        {
            method: "GET",
            path: "/plugin/web-links/segment",
            async handle(ctx) {
                const encodedUrl = String(ctx.query.get("u") || "");
                let target: string;
                try {
                    target = Buffer.from(encodedUrl, "base64url").toString("utf8");
                } catch {
                    return { status: 400, body: "bad segment url" };
                }
                if (!/^https?:\/\//.test(target)) return { status: 400, body: "bad segment url" };

                const encodedRef = String(ctx.query.get("ref") || "");
                const referrer = encodedRef ? Buffer.from(encodedRef, "base64url").toString("utf8") : undefined;

                const { fetch: fetchImpl } = await makeVpnAwareFetch(host, PLUGIN_ID, (ctx.client as { session?: unknown }).session);
                const range = ctx.headers.range;

                try {
                    const upstream = await fetchImpl(target, {
                        headers: {
                            ...(referrer ? { Referer: referrer } : {}),
                            ...(typeof range === "string" ? { Range: range } : {})
                        }
                    });
                    const buffer = Buffer.from(await upstream.arrayBuffer());
                    const headers: Record<string, string> = {
                        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
                        "cache-control": "no-store",
                        "accept-ranges": "bytes"
                    };
                    const contentRange = upstream.headers.get("content-range");
                    if (contentRange) headers["content-range"] = contentRange;

                    return { status: upstream.status, headers, body: buffer };
                } catch (cause) {
                    console.warn(`[web-links] segment fetch failed for ${target}:`, cause);
                    return { status: 502, body: "could not fetch segment" };
                }
            }
        }
    ];

    async function extraStreamsFor(type: string, id: string, session?: unknown): Promise<{ value: ExtraStream }[]> {
        const all = await scrapersPromise;
        const enabled = all.filter((s) => scraperEnabled(s.id));
        if (enabled.length === 0) return [];

        const { fetch: fetchImpl, proxyUrl } = await makeVpnAwareFetch(host, PLUGIN_ID, session);
        // Title isn't handed to a plugin's extraStreamsFor today -- fall
        // back to the raw id as the search term until stremio-tv threads
        // one through; a scraper that needs richer metadata can fetch it
        // itself via `id`.
        const query = parseQuery(type, id, id);
        const sessionId = (session as { id?: string } | undefined)?.id;

        const perScraper = await Promise.all(
            enabled.map(async (scraper) => ({ scraper, links: await runScraper(scraper, query, fetchImpl, proxyUrl) }))
        );

        return perScraper.flatMap(({ scraper, links }) => {
            return links.map((link) => ({
                value: {
                    url: link.resolveId
                        ? resolveEndpoint(scraper.id, link.resolveId, link.resolveKind, query, sessionId)
                        : link.url,
                    name: link.quality,
                    title: link.title,
                    description: [link.size, ...(link.labels ?? [])].filter(Boolean).join(" · ") || undefined
                } satisfies ExtraStream
            }));
        });
    }

    return {
        id: PLUGIN_ID,
        name: "Web Links",
        version: "0.4.0",
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};

export default createPlugin;
