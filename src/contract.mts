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
    settingsLink?: { label: string; href: string };
    configDir: string;
}

export type PluginFactory = (host: PluginHost, configDir: string) => StremioTvPlugin;

/** Only the host methods this plugin calls. See `src/plugin-types.ts` in
 *  stremio-tv for the full surface. */
export interface PluginHost {
    fetchVia?(url: string, options?: Record<string, unknown>): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
    requestVpnCapability(pluginId: string, session?: unknown): Promise<VpnCapability>;
    render: {
        escape(value: unknown): string;
    };
}
