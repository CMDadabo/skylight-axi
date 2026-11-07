import { AxiError } from "axi-sdk-js";
import { asArray, flat, str, type Client, type Doc, type Res } from "./client.js";

export const TRUNC = 300;
export function trunc(v: unknown, n = TRUNC): unknown {
  return typeof v === "string" && v.length > n ? `${v.slice(0, n)}… (truncated, ${v.length} chars)` : v;
}
export const truncRow = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, trunc(v)]));

export interface Member {
  id: string;
  label: string;
}

export async function loadMembers(c: Client): Promise<Member[]> {
  const doc = await c.frameGet("/categories");
  return asArray(doc?.data).map((r) => ({ id: r.id, label: str(r.attributes?.label) ?? r.id }));
}

/** Resolve a member by id or (case-insensitive) label. */
export async function resolveMember(c: Client, ref: string): Promise<Member> {
  const all = await loadMembers(c);
  const exact = all.filter((m) => m.id === ref || m.label.toLowerCase() === ref.toLowerCase());
  const hits = exact.length ? exact : all.filter((m) => m.label.toLowerCase().includes(ref.toLowerCase()));
  if (hits.length === 1) return hits[0];
  const list = all.map((m) => `${m.label} (${m.id})`).join(", ");
  throw new AxiError(
    hits.length ? `member "${ref}" is ambiguous` : `no member matches "${ref}"`,
    "VALIDATION_ERROR",
    [`members: ${list || "none"}`],
  );
}

/** Resolve the sideloaded `categories` of events into member labels. */
export function eventRows(doc: Doc | undefined): Record<string, unknown>[] {
  const labels = new Map<string, string>();
  for (const r of doc?.included ?? []) if (r.type === "category") labels.set(r.id, str(r.attributes?.label) ?? r.id);
  return asArray(doc?.data).map((e) => {
    const rel = asArray(e.relationships?.categories?.data);
    return { ...flat(e), members: rel.map((x) => labels.get(x.id) ?? x.id).join(",") };
  });
}

export function pick(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? ""])));
}

export const relIds = (r: Res, rel: string) => asArray(r.relationships?.[rel]?.data).map((x) => x.id);

/** Run a delete; a 404 means the desired state already holds. */
export async function idempotentDelete(what: string, fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
    return { deleted: what };
  } catch (e) {
    if (e instanceof AxiError && e.code === "NOT_FOUND") return { deleted: `${what} (already gone, no-op)` };
    throw e;
  }
}

