import type { PluginHost, VpnStatus } from "../contract.mjs";
import type { GithubSource } from "../github-import.mjs";

export interface ScraperRow {
    id: string;
    name: string;
    enabled: boolean;
    version?: string;
    /** The package directory it was loaded from -- what Update acts on. */
    packageId?: string;
}

export interface GithubSourceRow extends GithubSource {
    hasToken: boolean;
}

export interface ImportSummary {
    id?: string;
    version?: string;
    updated: boolean;
    upToDate?: boolean;
    error?: string;
}

export function importSummary(result: ImportSummary): string {
    if (result.upToDate) return `${result.id ? `${result.id}: ` : ""}no update available${result.version ? ` (v${result.version} is the latest)` : ""}.`;
    if (result.error) return `${result.id ? `${result.id}: ` : ""}${result.error}`;
    if (result.updated) return `Installed ${result.id}${result.version ? ` v${result.version}` : ""}.`;
    return "Nothing to import.";
}

/** Mirrors the Live TV plugin's own `/tv/scrapers` page -- same layout,
 *  same three ways to add a source (GitHub import, drop-in, build-in isn't
 *  offered here since this plugin ships no built-in scrapers at all). */
export function scrapersPage(
    host: PluginHost,
    client: unknown,
    signedIn: boolean,
    rows: ScraperRow[],
    githubSources: GithubSourceRow[] = [],
    note: { text: string; ok: boolean } | null = null,
    vpn: VpnStatus | null = null,
    linkTo: (path: string) => string = (p) => p
): string {
    const escape = host.render.escape;

    const list = rows
        .map((row) => {
            const toggle = `<a class="step" href="${escape(`${linkTo("/plugin/web-links")}?${row.enabled ? "off" : "on"}=${encodeURIComponent(row.id)}`)}">${row.enabled ? "Disable" : "Enable"}</a>`;

            // A dialog needs a script and a page may carry only one, so the
            // confirmation is the browser's own, attached inline. Delete acts
            // on the whole package, which may hold several scrapers.
            const remove = row.packageId
                ? `<form method="POST" action="${escape(linkTo("/plugin/web-links/scraper-delete"))}" style="display:inline" onsubmit="return confirm('Delete ${escape(row.packageId).replace(/'/g, "")} and every scraper in it? This cannot be undone.')"><input type="hidden" name="id" value="${escape(row.packageId)}"><button class="step" type="submit">Delete</button></form>`
                : "";

            return `<li class="railrow${row.enabled ? "" : " railoff"}">
<span class="railname">${escape(row.name)}${row.version ? ` <span class="railsay">v${escape(row.version)}</span>` : ""}</span>
<span class="railsay">${escape(row.id)}</span>
<span class="railacts">${row.packageId ? `<form method="POST" action="${escape(linkTo("/plugin/web-links/scraper-update"))}" style="display:inline"><input type="hidden" name="id" value="${escape(row.packageId)}"><button class="step" type="submit">Update</button></form>` : ""}${toggle}${remove}</span>
</li>`;
        })
        .join("\n");

    const sourcesList = githubSources
        .map((source) => {
            return `<li class="railrow">
<span class="railname">${escape(`${source.owner}/${source.repo}`)}${source.hasToken ? ` <span class="railsay">token saved</span>` : ""}</span>
<span class="railacts">
<form method="POST" action="${escape(linkTo("/plugin/web-links/github-recheck"))}" style="display:inline">
<input type="hidden" name="owner" value="${escape(source.owner)}">
<input type="hidden" name="repo" value="${escape(source.repo)}">
<button class="step" type="submit">Check for updates</button>
</form>
<form method="POST" action="${escape(linkTo("/plugin/web-links/github-forget"))}" style="display:inline">
<input type="hidden" name="owner" value="${escape(source.owner)}">
<input type="hidden" name="repo" value="${escape(source.repo)}">
<button class="step" type="submit">Forget</button>
</form>
</span>
</li>`;
        })
        .join("\n");

    // `.routing` is what the sheet is positioned against; without it the sheet lands on the nav bar.
    const rawVpn = host.vpnBadge(vpn, "links") + host.vpnSheet(vpn, linkTo("/vpn"), "/plugin/web-links", "links");
    const vpnPanel = rawVpn ? `<section class="routing">${rawVpn}</section>` : "";

    return host.render.page({
        title: "Web Links",
        body: `${host.render.chrome(client, "settings", signedIn)}
<div class="tvhead">
<h1>Web Links</h1>
<p class="bar"><a class="step" href="${escape(linkTo("/settings"))}">&lsaquo; Settings</a></p>
</div>
<p class="hint">Searches HTTP-hosted web links for the title you're playing, using whatever scrapers are dropped in below. Their results show up in their own column on the &ldquo;select quality&rdquo; screen, separate from torrent sources.</p>
${
    vpnPanel
        ? `<h3 class="lead">The VPN</h3>
<p class="hint">A scraper's own HTTP calls -- and, for a scraper that drives a real browser, that browser's traffic too -- go through the same household tunnel Live TV and Riven share. Changing it here changes it everywhere.</p>
${vpnPanel}`
        : ""
}
<h3 class="lead">Loaded scrapers</h3>
${note ? `<p class="hint${note.ok ? "" : " error"}">${escape(note.text)}</p>` : ""}
${list.length ? `<ul class="rails">\n${list}\n</ul>` : `<p class="empty">No scrapers are configured.</p>`}
<p class="bar"><a class="step" href="${escape(`${linkTo("/plugin/web-links")}?reload=1`)}">Reload sources</a></p>
<h3 class="lead">Import from GitHub</h3>
<p class="hint">Reads a repository's <code>dist/</code> directory -- its <code>scraper.json</code> manifest plus every file it names -- and installs or updates whichever scraper that id names, only when the fetched build's version is a real increase over what is already running. A token is only needed for a private repository, and is remembered so you do not retype it on the next check.</p>
<form method="POST" action="${escape(linkTo("/plugin/web-links/github-import"))}">
<label for="gh-repo">Repository (owner/repo)</label>
<input id="gh-repo" name="repo" type="text" placeholder="gauravsuman007/stremio-tv-plugin-web-scraper" autocapitalize="off" autocomplete="off">
<label for="gh-token">Access token (private repos only)</label>
<input id="gh-token" name="token" type="password" autocomplete="off" placeholder="leave blank to keep the saved one">
<button class="go" type="submit">Import</button>
</form>
${sourcesList ? `<ul class="rails">\n${sourcesList}\n</ul>` : ""}
<h3 class="lead">Dropping one in by hand</h3>
<p class="hint">A scraper is a small package, not a single file this page accepts from a form &mdash; it runs with the same reach as the rest of this service. Build one against <code>templates/scraper-template.mts</code> in this plugin's own repository, compile it (the template's header has the exact command), and copy the resulting <code>dist/</code> tree to <code>&lt;pluginsDir&gt;/web-links/data/scrapers/&lt;id&gt;/</code> on the mounted data volume (so <code>scraper.json</code> lands at <code>.../&lt;id&gt;/scraper.json</code>). Press &ldquo;Reload sources&rdquo; above, or restart, to pick it up -- no image rebuild, no redeploy.</p>
<h3 class="lead">Versioning</h3>
<p class="hint">A scraper's <code>scraper.json</code> may set a <code>version</code> (dot-separated numbers, e.g. <code>1.2.0</code>). Importing from GitHub only ever replaces a scraper already running with a strictly newer version. &ldquo;Reload sources&rdquo; above is different: it re-reads the dropped-in directory as-is, no version check, because a file that landed there was already a deliberate choice by whoever copied it in.</p>`
    });
}
