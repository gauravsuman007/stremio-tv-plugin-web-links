import type { PluginFactory, PluginRoute, ExtraStream } from "./contract.mjs";
import type { WebLinkQuery, WebLinkScraper } from "./scraper.mjs";
import { loadScrapers } from "./registry.mjs";
import { makeVpnAwareFetch } from "./vpn-fetch.mjs";

const PLUGIN_ID = "web-links";

/** Best-effort content-id parsing. Mirrors the "imdbId[:season:episode]"
 *  shape stremio-tv's own addon path already uses for series ids -- a
 *  plugin gets the raw string, not a parsed struct, since it never owns
 *  these ids itself. */
function parseQuery(type: string, id: string, title: string): WebLinkQuery {
    const [, seasonStr, episodeStr] = id.split(":");
    const season = seasonStr ? Number(seasonStr) : undefined;
    const episode = episodeStr ? Number(episodeStr) : undefined;
    return { type, id, title, season, episode };
}

/** One search budget shared across every scraper for a single title, so a
 *  slow or hung scraper can't stall the whole `extraStreamsFor` call --
 *  and, in turn, the user's "select quality" screen. */
const SEARCH_BUDGET_MS = 8000;

async function runScraper(scraper: WebLinkScraper, query: WebLinkQuery, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    const started = Date.now();
    const timeout = new Promise<[]>((resolve) => setTimeout(() => resolve([]), SEARCH_BUDGET_MS));
    const run = scraper
        .search(query, { fetch: fetchImpl, budgetMs: SEARCH_BUDGET_MS })
        .catch((cause) => {
            console.warn(`[web-links] scraper ${scraper.id} failed:`, cause);
            return [];
        });
    void started;
    return Promise.race([run, timeout]);
}

const createPlugin: PluginFactory = (host, configDir) => {
    let scrapersPromise = loadScrapers(configDir);

    const routes: PluginRoute[] = [
        {
            method: "GET",
            path: "/plugin/web-links",
            async handle() {
                const scrapers = await scrapersPromise;
                const rows = scrapers
                    .map((scraper) => `<li>${host.render.escape(scraper.name)} (<code>${host.render.escape(scraper.id)}</code>)</li>`)
                    .join("");
                const body = `<h1>Web Links</h1>
<p>Searches HTTP-hosted web links for the title you're playing, using pluggable scrapers. No scrapers ship by default -- drop a compiled scraper into this plugin's <code>data/scrapers/</code> folder (see <code>templates/scraper-template.mts</code>).</p>
<h2>Loaded scrapers (${scrapers.length})</h2>
<ul>${rows || "<li><em>none</em></li>"}</ul>`;
                return { body, headers: { "content-type": "text/html" } };
            }
        },
        {
            method: "POST",
            path: "/plugin/web-links/reload",
            async handle() {
                scrapersPromise = loadScrapers(configDir);
                await scrapersPromise;
                return { status: 302, headers: { location: "/plugin/web-links" }, body: "" };
            }
        }
    ];

    async function extraStreamsFor(type: string, id: string, session?: unknown): Promise<{ value: ExtraStream }[]> {
        const scrapers = await scrapersPromise;
        if (scrapers.length === 0) return [];

        const fetchImpl = await makeVpnAwareFetch(host, PLUGIN_ID, session);
        // Title isn't handed to a plugin's extraStreamsFor today -- fall
        // back to the raw id as the search term until stremio-tv threads
        // one through; a scraper that needs richer metadata can fetch it
        // itself via `id`.
        const query = parseQuery(type, id, id);

        const results = await Promise.all(scrapers.map((scraper) => runScraper(scraper, query, fetchImpl)));

        return results.flat().map((link) => ({
            value: {
                url: link.url,
                name: link.quality,
                title: link.title,
                description: [link.size, ...(link.labels ?? [])].filter(Boolean).join(" · ") || undefined
            } satisfies ExtraStream
        }));
    }

    return {
        id: PLUGIN_ID,
        name: "Web Links",
        version: "0.1.0",
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};

export default createPlugin;
