import { AxiError } from "axi-sdk-js";
import { dateRange, parseArgs, requirePosOrFail, str, usageError, type Spec } from "../args.js";
import { asArray, enc, flat, flatAll, type Client, type Doc } from "../client.js";
import { idempotentDelete, loadMembers, pick, truncRow } from "../util.js";

// ---- members / points -------------------------------------------------------
export async function membersCommand(args: string[], c: Client) {
  parseArgs(args, { usage: "skylight-axi members", flags: {} });
  const doc = await c.frameGet("/categories");
  const rows = flatAll(doc);
  if (!rows.length) return { members: "0 family members/categories on this frame" };
  return { count: rows.length, members: pick(rows, ["id", "label", "color"]) };
}

export async function pointsCommand(args: string[], c: Client) {
  parseArgs(args, { usage: "skylight-axi points", flags: {} });
  const doc = await c.frameGet("/reward_points");
  const names = new Map((await loadMembers(c)).map((m) => [m.id, m.label]));
  const rows = asArray(doc?.data).map((r) => ({ ...flat(r), member: names.get(String(r.attributes?.category_id ?? r.id)) ?? "" }));
  if (!rows.length) return { points: "no reward points recorded" };
  return { points: rows.map(truncRow) };
}

// ---- task box ---------------------------------------------------------------
const TADD: Spec = { usage: 'skylight-axi tasks add "<title>" [--points N] [--emoji X]', flags: { points: "string", emoji: "string" } };
export const TASKS_HELP = `usage: skylight-axi tasks <subcommand>   (the Skylight task box)
  [list]
  add "<title>" [--points N] [--emoji X]
  delete <id>
`;
export async function tasksCommand(args: string[], c: Client) {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);
  if (sub === "list") {
    parseArgs(rest, { usage: "skylight-axi tasks", flags: {} });
    const rows = flatAll(await c.frameGet("/task_box/items"));
    if (!rows.length) return { tasks: "0 items in the task box", help: ['Run `skylight-axi tasks add "<title>"` to add one'] };
    return { count: rows.length, tasks: pick(rows, ["id", "summary", "reward_points"]) };
  }
  if (sub === "add") {
    const { pos, flags } = parseArgs(rest, TADD);
    requirePosOrFail(pos, 1, TADD.usage, "task title");
    const points = str(flags.points) === undefined ? undefined : Number(flags.points);
    if (points !== undefined && !Number.isFinite(points)) throw usageError("--points must be a number", TADD.usage);
    const body = { summary: pos.join(" "), reward_points: points, emoji_icon: str(flags.emoji) };
    const doc = (await c.frameSend("POST", "/task_box/items", Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))) as Doc;
    const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
    return { created: { id: r?.id, summary: body.summary } };
  }
  if (sub === "delete") {
    const { pos } = parseArgs(rest, { usage: "skylight-axi tasks delete <id>", flags: {} });
    requirePosOrFail(pos, 1, "skylight-axi tasks delete <id>", "task id");
    return idempotentDelete(`task ${pos[0]}`, () => c.frameSend("DELETE", `/task_box/items/${enc(pos[0])}`));
  }
  throw new AxiError(`unknown tasks subcommand "${sub}"`, "VALIDATION_ERROR", ["valid: list, add, delete"]);
}

// ---- meals ------------------------------------------------------------------
const MEALS: Spec = { usage: "skylight-axi meals [--from D] [--to D | --days N]", flags: { from: "string", to: "string", days: "string" } };
export async function mealsCommand(args: string[], c: Client) {
  const { flags } = parseArgs(args, MEALS);
  const { from, to } = dateRange(flags, MEALS.usage, 7);
  const doc = await c.frameGet("/meals/sittings", { date_min: from, date_max: to, include: "meal_category,meal_recipe" });
  const inc = new Map((doc?.included ?? []).map((r) => [`${r.type}:${r.id}`, r.attributes ?? {}]));
  const rows = asArray(doc?.data).map((s) => {
    const ref = (rel: string) => {
      const d = s.relationships?.[rel]?.data;
      const one = Array.isArray(d) ? d[0] : d;
      return one ? inc.get(`${one.type}:${one.id}`) : undefined;
    };
    const instances = asArray(s.attributes?.instances as unknown[] | undefined).map(String);
    return {
      id: s.id,
      date: instances.filter((d) => d >= from && d <= to).join(",") || instances.join(","),
      slot: String(ref("meal_category")?.label ?? ""),
      meal: String(s.attributes?.summary ?? ref("meal_recipe")?.summary ?? ref("meal_recipe")?.name ?? ""),
    };
  });
  if (!rows.length) return { meals: `0 meals planned from ${from} to ${to}` };
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { range: `${from}..${to}`, count: rows.length, meals: rows };
}

// ---- raw api escape hatch ---------------------------------------------------
const API: Spec = {
  usage: "skylight-axi api <GET|POST|PUT|PATCH|DELETE> </path> [--query k=v]... [--body '<json>']",
  flags: { query: "string", body: "string" },
};
export const API_HELP = `usage: ${API.usage}
Raw Skylight API call (JSON:API response, truncated). Paths are relative to /api.
Use "{frame}" in the path for the resolved frame id.
examples:
  skylight-axi api GET /frames/{frame}/devices
  skylight-axi api PUT /frames/{frame}/lists/1 --body '{"label":"Groceries"}'
`;
export async function apiCommand(args: string[], c: Client) {
  const { pos, flags } = parseArgs(args, API);
  requirePosOrFail(pos, 2, API.usage, "method and path");
  const method = pos[0].toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw usageError(`bad method "${pos[0]}"`, API.usage);
  if (!pos[1].startsWith("/")) throw usageError("path must start with /", API.usage);
  let path = pos[1];
  if (path.includes("{frame}")) path = path.replaceAll("{frame}", enc(await c.frameId()));
  const query: Record<string, string> = {};
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--query" && args[i + 1]) {
      const [k, ...v] = args[++i].split("=");
      query[k] = v.join("=");
    }
  let body: unknown;
  if (str(flags.body) !== undefined) {
    try {
      body = JSON.parse(str(flags.body)!);
    } catch {
      throw usageError("--body must be valid JSON", API.usage);
    }
  }
  const out = await c.request(method, path, { query, body });
  const text = JSON.stringify(out ?? null);
  return { status: "ok", response: text.length > 4000 ? `${text.slice(0, 4000)}… (truncated, ${text.length} chars)` : out ?? null };
}
