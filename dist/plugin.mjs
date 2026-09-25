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
        const results = await Promise.all(enabled.map((scraper) => runScraper(scraper, query, fetchImpl, proxyUrl)));
        return results.flat().map((link) => ({
            value: {
                url: link.url,
                name: link.quality,
                title: link.title,
                description: [link.size, ...(link.labels ?? [])].filter(Boolean).join(" · ") || undefined
            }
        }));
    }
    return {
        id: PLUGIN_ID,
        name: "Web Links",
        version: "0.2.1",
        apiVersion: "1.0.0",
        routes: () => routes,
        extraStreamsFor,
        settingsLink: { label: "Web Links", href: "/plugin/web-links" },
        configDir
    };
};
export default createPlugin;
