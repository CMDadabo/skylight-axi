import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePosOrFail, str, usageError, type Spec } from "../args.js";

/**
 * API discovery from browser HAR captures, after TheEagleByte/skylight-api's method
 * (HAR -> filter /api calls -> normalize IDs -> infer shapes -> redact), without its
 * OpenAPI toolchain. SAFETY: a HAR holds bearer tokens and family PII, so this command
 * only ever prints structure (methods, paths, key names, types, status codes) -
 * never header values, query values, or body values.
 */
const SPEC: Spec = {
  usage: 'skylight-axi discover <file.har>... [--new] [--show "<METHOD> <path>"]',
  flags: { new: "boolean", show: "string" },
};

export const DISCOVER_HELP = `usage: ${SPEC.usage}
Find Skylight API endpoints in HAR files exported from browser DevTools
(Network tab -> "Save all as HAR with content" while using app.ourskylight.com).
Lists METHOD + normalized path, status codes, call count, query-param names, and
whether skylight-axi already has a command for it. Prints structure only - never values.
flags:
  --new                    only endpoints skylight-axi has no command for
  --show "<METHOD> <path>" request/response shape of one endpoint (path as listed)
examples:
  skylight-axi discover ~/Downloads/app.ourskylight.com.har --new
  skylight-axi discover traffic.har --show "GET /frames/{frame}/meals/sittings"
Call an endpoint you find with: skylight-axi api <METHOD> <path>   ({frame} is substituted; replace other {..._id} with real ids)
`;

// ---- HAR types (only what we read) -----------------------------------------
interface HarEntry {
  request: { method: string; url: string; postData?: { text?: string } };
  response: { status: number; content?: { text?: string; encoding?: string } };
}

// ---- path normalization -----------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\w:.+-]*)?$/;
const singular = (s: string) => s.replace(/ies$/, "y").replace(/s$/, "");

export function normalizePath(path: string): string {
  const segs = path.split("/");
  return segs
    .map((seg, i) => {
      if (!seg) return seg;
      const prev = segs[i - 1];
      if (prev === "frames") return "{frame}";
      if (DATE.test(seg)) return "{date}";
      // numeric, uuid, or composite ids like "8978239862-1793491200" / "70550326-2026-11-04"
      if (UUID.test(seg) || /^\d+(-\d+)*$/.test(seg) || /^\d{4,}-/.test(seg) || (/\d{5,}/.test(seg) && !/^[a-z_]+$/.test(seg))) {
        return `{${singular(prev ?? "id").replace(/\W+/g, "_")}_id}`;
      }
      return seg;
    })
    .join("/");
}

// ---- what skylight-axi already covers --------------------------------------
const COVERED: Array<[RegExp, string]> = [
  [/^GET \/frames$/, "(frame lookup)"],
  [/^(GET|POST) \/frames\/\{frame\}\/calendar_events$/, "events"],
  [/^(PUT|DELETE) \/frames\/\{frame\}\/calendar_events\/\{calendar_event_id\}$/, "events"],
  [/^GET \/frames\/\{frame\}\/categories$/, "members"],
  [/^GET \/frames\/\{frame\}\/chores$/, "chores"],
  [/^POST \/frames\/\{frame\}\/chores$/, "chores add"],
  [/^PUT \/frames\/\{frame\}\/chores\/\{chore_id\}\/completions$/, "chores done|reopen"],
  [/^DELETE \/frames\/\{frame\}\/chores\/\{chore_id\}$/, "chores delete"],
  [/^(GET|POST) \/frames\/\{frame\}\/lists$/, "lists"],
  [/^(GET|POST) \/frames\/\{frame\}\/lists\/\{list_id\}\/list_items$/, "lists"],
  [/^(PATCH|PUT|DELETE) \/frames\/\{frame\}\/lists\/\{list_id\}\/list_items\/\{list_item_id\}$/, "lists"],
  [/^GET \/frames\/\{frame\}\/reward_points$/, "points"],
  [/^GET \/frames\/\{frame\}\/meals\/sittings$/, "meals"],
  [/^(GET|POST) \/frames\/\{frame\}\/task_box\/items$/, "tasks"],
  [/^DELETE \/frames\/\{frame\}\/task_box\/items\/\{item_id\}$/, "tasks delete"],
];
const coveredBy = (key: string) => COVERED.find(([re]) => re.test(key))?.[1] ?? "";

// ---- shape inference (types only, never values) ----------------------------
function shape(v: unknown, depth = 3): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth - 1)] : "[]";
  if (typeof v === "object") {
    if (depth <= 0) return "{…}";
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x, depth - 1)]));
  }
  return typeof v;
}

/** JSON:API-aware summary: resource types, attribute names+types, relationship names, included types. */
function summarize(body: unknown): unknown {
  const doc = body as { data?: unknown; included?: unknown[]; meta?: object } | null;
  if (!doc || typeof doc !== "object" || !("data" in doc)) return shape(body);
  const first = (Array.isArray(doc.data) ? doc.data[0] : doc.data) as
    | { type?: string; attributes?: object; relationships?: object }
    | undefined;
  const out = {
    data: Array.isArray(doc.data) ? "array" : doc.data === null ? "null" : "object",
    type: first?.type,
    attributes: first?.attributes ? shape(first.attributes, 1) : undefined,
    relationships: first?.relationships ? Object.keys(first.relationships) : undefined,
    included: doc.included?.length ? [...new Set(doc.included.map((r) => (r as { type?: string }).type))] : undefined,
    meta: doc.meta ? Object.keys(doc.meta) : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function parseJson(text: string | undefined, encoding?: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text);
  } catch {
    return undefined;
  }
}

interface Agg {
  method: string;
  path: string;
  statuses: Set<number>;
  calls: number;
  query: Set<string>;
  reqBody?: unknown;
  resBody?: unknown;
}

export function aggregate(entries: HarEntry[]): { apiCalls: number; endpoints: Map<string, Agg> } {
  const endpoints = new Map<string, Agg>();
  let apiCalls = 0;
  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      continue;
    }
    if (url.hostname !== "app.ourskylight.com" || !url.pathname.startsWith("/api/")) continue;
    const method = e.request.method.toUpperCase();
    if (method === "OPTIONS") continue;
    apiCalls++;
    const path = normalizePath(url.pathname.slice(4));
    const key = `${method} ${path}`;
    const a = endpoints.get(key) ?? { method, path, statuses: new Set(), calls: 0, query: new Set() };
    a.calls++;
    a.statuses.add(e.response.status);
    for (const k of url.searchParams.keys()) a.query.add(k);
    // keep the shape from the first successful call
    if (e.response.status < 300 && a.resBody === undefined)
      a.resBody = summarize(parseJson(e.response.content?.text, e.response.content?.encoding));
    if (a.reqBody === undefined && e.request.postData?.text) {
      const b = parseJson(e.request.postData.text);
      if (b !== undefined) a.reqBody = shape(b);
    }
    endpoints.set(key, a);
  }
  return { apiCalls, endpoints };
}

export function discoverCommand(args: string[]) {
  const { pos, flags } = parseArgs(args, SPEC);
  requirePosOrFail(pos, 1, SPEC.usage, "at least one .har file");
  const entries: HarEntry[] = [];
  for (const f of pos) {
    let har: { log?: { entries?: HarEntry[] } };
    try {
      har = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new AxiError(code === "ENOENT" ? `file not found: ${f}` : `not a readable HAR file: ${f}`, "VALIDATION_ERROR", [SPEC.usage]);
    }
    if (!har.log?.entries) throw new AxiError(`not a HAR file (no log.entries): ${f}`, "VALIDATION_ERROR", [SPEC.usage]);
    entries.push(...har.log.entries);
  }
  const { apiCalls, endpoints } = aggregate(entries);
  if (!apiCalls) {
    return { discover: `0 Skylight API calls found in ${entries.length} HAR entries`, help: ["Capture while using app.ourskylight.com with DevTools open; look for requests to /api/..."] };
  }

  const show = str(flags.show);
  if (show) {
    const a = endpoints.get(show.replace(/\s+/g, " ").trim().replace(/^(\w+)/, (m) => m.toUpperCase()));
    if (!a) throw new AxiError(`endpoint not in capture: ${show}`, "NOT_FOUND", ["Run `skylight-axi discover <file>` to list endpoints"]);
    return {
      endpoint: `${a.method} ${a.path}`,
      status: [...a.statuses].sort().join(","),
      calls: a.calls,
      query: [...a.query].join(",") || "(none)",
      request_body: a.reqBody ?? "(none)",
      response: a.resBody ?? "(none or non-JSON)",
      covered_by: coveredBy(`${a.method} ${a.path}`) || "(not covered)",
      help: [`Call it: skylight-axi api ${a.method} ${a.path}` + (/\{(?!frame\})/.test(a.path) ? "   (replace {..._id} with a real id; {frame} is automatic)" : "")],
    };
  }

  let rows = [...endpoints.values()].map((a) => ({
    method: a.method,
    path: a.path,
    status: [...a.statuses].sort().join(","),
    calls: a.calls,
    query: [...a.query].join(","),
    covered: coveredBy(`${a.method} ${a.path}`) || "no",
  }));
  const uncovered = rows.filter((r) => r.covered === "no").length;
  if (flags.new) rows = rows.filter((r) => r.covered === "no");
  rows.sort((a, b) => (a.covered === "no" ? 0 : 1) - (b.covered === "no" ? 0 : 1) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (!rows.length) return { discover: `all ${endpoints.size} endpoints in this capture are already covered by skylight-axi` };
  return {
    summary: `${apiCalls} API calls, ${endpoints.size} endpoints, ${uncovered} not covered`,
    endpoints: rows,
    help: ['Run `skylight-axi discover <file> --show "<METHOD> <path>"` for request/response shape', "Run `skylight-axi discover <file> --new` for uncovered endpoints only"],
  };
}
