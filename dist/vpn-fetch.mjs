/**
 * Builds one `fetch`-shaped function (and, when relevant, the raw proxy
 * address) scrapers use for the lifetime of a single search. Routes through
 * the household VPN tunnel when `requestVpnCapability` says one is
 * configured, otherwise falls back to plain `fetch` -- exactly the
 * "degrade to not-configured, never throw" rule the host capability itself
 * follows.
 *
 * `liveProxy` is resolved lazily (see `PluginHost.requestVpnCapability`'s
 * own doc comment in stremio-tv) so a household with no VPN configured
 * never pays for a status check it doesn't need, and one call's proxy is
 * reused across every scraper invoked for that search rather than
 * re-resolved per scraper.
 */
export async function makeVpnAwareFetch(host, pluginId, session) {
    const plain = { fetch: (url, init) => fetch(url, init) };
    const capability = await host.requestVpnCapability(pluginId, session).catch(() => ({ configured: false }));
    if (!capability.configured || !capability.liveProxy)
        return plain;
    const proxyUrl = await capability.liveProxy(session).catch(() => null);
    if (!proxyUrl)
        return plain;
    const agent = await buildProxyAgent(proxyUrl);
    if (!agent)
        return plain;
    return { fetch: (url, init) => fetch(url, { ...init, dispatcher: agent }), proxyUrl };
}
/** Node's `fetch` takes an `undici` dispatcher for proxying, not a plain
 *  agent option. Isolated here so a missing/incompatible `undici` never
 *  breaks the whole plugin -- callers already fall back to plain `fetch`
 *  when this returns `undefined`. */
async function buildProxyAgent(proxyUrl) {
    try {
        // Imported dynamically: undici ships with Node but the exact export
        // surface can shift between LTS lines, and a plugin must never
        // crash the host process over it.
        const { ProxyAgent } = (await import("undici"));
        return new ProxyAgent(proxyUrl);
    }
    catch {
        return undefined;
    }
}
