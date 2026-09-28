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

export interface PluginRoute {
    method: "GET" | "POST";
    path: string;
    handle(ctx: PluginRouteContext): Promise<PluginResponse | void>;
}

export interface PluginRouteContext {
    method: string;
    path: string;
    query: URLSearchParams;
    form: URLSearchParams;
    headers: Record<string, string | string[] | undefined>;
    client: unknown;
    params: Record<string, string>;
}

export interface PluginResponse {
    status?: number;
    headers?: Record<string, string>;
    body: string | Buffer;
}

/** Shaped like an addon's own `Stream`, trimmed to the fields a
 *  supplementary web link ever needs. No `live`, no resume field of any
 *  kind -- see `docs/RESUME.md` for why. */
export interface ExtraStream {
    url?: string;
    name?: string;
    title?: string;
    description?: string;
    behaviorHints?: { bingeGroup?: string; filename?: string; [key: string]: unknown };
}

export interface VpnCapability {
    configured: boolean;
    status?: unknown;
    liveProxy?: (session?: unknown) => Promise<string>;
}

export interface StremioTvPlugin {
    id: string;
    name: string;
    version?: string;
    apiVersion?: string;
    routes?(): PluginRoute[];
    extraStreamsFor?(type: string, id: string, session?: unknown): Promise<{ from?: unknown; value: ExtraStream }[]>;
    /** Plugin API 1.1.0: this plugin draws its own column on the "select
     *  quality" screen; an older host never calls it. */
    streamColumn?(input: StreamColumnInput): StreamColumn | null;
    settingsLink?: { label: string; href: string };
    configDir: string;
}

/** One of this plugin's streams, with the `/play` link stremio-tv built. */
export interface StreamColumnRow {
    href: string;
    from: { manifest: { id: string; name?: string } };
    stream: ExtraStream;
}

export interface StreamColumnInput {
    type: string;
    id: string;
    title: string;
    rows: StreamColumnRow[];
    /** Null for a live channel, or when no tunnel is configured. */
    vpn: VpnStatus | null;
    vpnAction: string;
    back: string;
}

export interface StreamColumn {
    heading: string;
    html: string;
}

export type PluginFactory = (host: PluginHost, configDir: string) => StremioTvPlugin;

export interface VpnStatus {
    [key: string]: unknown;
}

/** Only the host methods this plugin calls. See `src/plugin-types.ts` in
 *  stremio-tv for the full surface. */
export interface PluginHost {
    requestVpnCapability(pluginId: string, session?: unknown): Promise<VpnCapability>;
    vpnBadge(status: VpnStatus | null, scope?: "live" | "links"): string;
    vpnSheet(status: VpnStatus | null, action: string, back: string, scope?: "live" | "links"): string;
    render: {
        escape(value: unknown): string;
        page(options: { title: string; body: string }): string;
        chrome(client: unknown, current: string, signedIn: boolean): string;
    };
}
