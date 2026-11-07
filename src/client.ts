import { AxiError } from "axi-sdk-js";
import { Auth, loadConfig, type Config } from "./auth.js";

const API_VERSION = "2026-05-01";
const TIMEOUT_MS = 30_000;

export interface ReqOpts {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/** JSON:API resource. */
export interface Res {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | Array<{ id: string; type: string }> | null }>;
}
export interface Doc {
  data?: Res | Res[] | null;
  included?: Res[];
}

export class Client {
  private frame?: { id: string; name?: string };
  constructor(
    readonly cfg: Config,
    readonly auth: Auth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static create(): Client {
    const cfg = loadConfig();
    return new Client(cfg, new Auth(cfg));
  }

  async request<T = Doc | undefined>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    let token = await this.auth.token();
    for (let attempt = 0, renewed = false; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "skylight-api-version": API_VERSION,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 && !renewed) {
        renewed = true;
        token = await this.auth.renew();
        continue;
      }
      if (res.status === 429 && attempt < 3) {
        const wait = Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 10);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw httpError(res.status, method, path, text);
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }

  /** The frame to operate on: SKYLIGHT_FRAME_ID, the only frame, or an actionable error. */
  async frameId(): Promise<string> {
    // An explicit frame id needs no lookup (saves a request per command).
    return this.cfg.frameId ?? (await this.frameInfo()).id;
  }

  async frameInfo(): Promise<{ id: string; name?: string }> {
    if (this.frame) return this.frame;
    const doc = await this.request<Doc>("GET", "/frames");
    const frames = asArray(doc?.data).map((f) => ({ id: f.id, name: str(f.attributes?.name) }));
    const pick = this.cfg.frameId ? frames.find((f) => f.id === this.cfg.frameId) ?? { id: this.cfg.frameId } : undefined;
    if (pick) return (this.frame = pick);
    if (frames.length === 1) return (this.frame = frames[0]);
    if (frames.length === 0) throw new AxiError("no Skylight frames on this account", "NOT_FOUND");
    throw new AxiError("account has multiple frames", "AMBIGUOUS_FRAME", [
      `set SKYLIGHT_FRAME_ID to one of: ${frames.map((f) => `${f.id} (${f.name ?? "?"})`).join(", ")}`,
    ]);
  }

  async frameGet(sub: string, query?: ReqOpts["query"]): Promise<Doc | undefined> {
    return this.request("GET", `/frames/${enc(await this.frameId())}${sub}`, { query });
  }
  async frameSend(method: string, sub: string, body?: unknown, query?: ReqOpts["query"]): Promise<Doc | undefined> {
    return this.request(method, `/frames/${enc(await this.frameId())}${sub}`, { body, query });
  }
}

export const enc = (s: string | number) => {
  const v = String(s);
  if (!v || v === "." || v === "..") throw new AxiError(`invalid id "${v}"`, "VALIDATION_ERROR");
  return encodeURIComponent(v);
};
export const asArray = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function httpError(status: number, method: string, path: string, body: string): AxiError {
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail = j.errors?.map?.((e: { detail?: string; title?: string }) => e.detail ?? e.title).join("; ") ?? j.error ?? j.message ?? "";
    // Unrecognized JSON shape: fall back to its compact form (error bodies carry no user data).
    if (!detail && body.trim().startsWith("{")) detail = body.replace(/\s+/g, " ");
  } catch {
    /* non-JSON body: never echo raw upstream output */
  }
  detail = String(detail).slice(0, 200);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 404) return new AxiError(`not found (${method} ${path})${suffix}`, "NOT_FOUND");
  if (status === 401 || status === 403) return new AxiError(`Skylight denied access (HTTP ${status})${suffix}`, "AUTH_FAILED");
  if (status === 422) return new AxiError(`Skylight rejected the request${suffix || " (HTTP 422)"}`, "VALIDATION_ERROR");
  if (status === 429) return new AxiError("Skylight rate limit hit; try again shortly", "RATE_LIMITED");
  return new AxiError(`Skylight API error HTTP ${status} (${method} ${path})${suffix}`, "API_ERROR");
}

/** Flatten resources to `{id, ...attributes}`. */
export const flat = (r: Res): Record<string, unknown> => ({ id: r.id, ...r.attributes });
export const flatAll = (doc: Doc | undefined) => asArray(doc?.data).map(flat);
