import type { PluginFactory, PluginRoute, PluginRouteContext, ExtraStream, VpnStatus } from "./contract.mjs";
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
 * A link into this plugin's own `/plugin/web-links/resolve` route, built
 * without a `client` (`extraStreamsFor` isn't handed one) -- plugins run
 * in-process with stremio-tv, so a loopback URL back into this same server
 * works fine. `session.id` is included so the resolve handler can VPN-route
 * the same way `extraStreamsFor` did; when it's missing, stremio-tv mints a
 * fresh session and redirects to it, path and query preserved, so the route
 * still resolves correctly either way.
 */
function resolveEndpoint(scraperId: string, resolveId: string, query: WebLinkQuery, sessionId: string | undefined): string {
    const params = new URLSearchParams({ scraper: scraperId, rid: resolveId, type: query.type, id: query.id, title: query.title });
    if (query.season != null) params.set("season", String(query.season));
    if (query.episode != null) params.set("episode", String(query.episode));
    const port = process.env.PORT || "3300";
    return `http://127.0.0.1:${port}/s/${sessionId || "resolve"}/plugin/web-links/resolve?${params.toString()}`;
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
                const scraperId = String(ctx.query.get("scraper") || "");
                const rid = String(ctx.query.get("rid") || "");
                const query: WebLinkQuery = {
                    type: String(ctx.query.get("type") || ""),
                    id: String(ctx.query.get("id") || ""),
                    title: String(ctx.query.get("title") || "")
                };
                const season = ctx.query.get("season");
                const episode = ctx.query.get("episode");
                if (season) query.season = Number(season);
                if (episode) query.episode = Number(episode);

                const all = await scrapersPromise;
                const scraper = all.find((s) => s.id === scraperId);
                if (!scraper?.resolve) return { status: 404, body: "unknown or non-resolving scraper" };

                const cacheKey = `${scraperId}:${rid}:${query.id}:${query.season ?? ""}:${query.episode ?? ""}`;
                const cached = resolveCache.get(cacheKey);
                let link: WebLink | null;

                if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
                    link = cached.link;
                } else {
                    const { fetch: fetchImpl, proxyUrl } = await makeVpnAwareFetch(
                        host,
                        PLUGIN_ID,
                        (ctx.client as { session?: unknown }).session
                    );
                    try {
                        link = await scraper.resolve(rid, query, { fetch: fetchImpl, budgetMs: SEARCH_BUDGET_MS, proxyUrl });
                    } catch (cause) {
                        console.warn(`[web-links] resolve failed for ${scraperId}/${rid}:`, cause);
                        link = null;
                    }
                    trimResolveCache();
                    resolveCache.set(cacheKey, { at: Date.now(), link });
                }

                if (!link) return { status: 502, body: "could not resolve this link right now" };

                return { status: 303, headers: { location: link.url }, body: "" };
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
                    url: link.resolveId ? resolveEndpoint(scraper.id, link.resolveId, query, sessionId) : link.url,
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
        version: "0.3.0",
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};

export default createPlugin;
