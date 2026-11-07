import { AxiError } from "axi-sdk-js";
import { addDays, dateRange, localDate, parseArgs, requireDate, requirePosOrFail, str, usageError, type Spec } from "../args.js";
import { asArray, enc, flat, type Client, type Doc } from "../client.js";
import { idempotentDelete, loadMembers, pick, relIds, resolveMember, truncRow } from "../util.js";

const LIST: Spec = { usage: "skylight-axi chores [list] [--from D] [--to D | --days N] [--member <name|id>] [--full]", flags: { from: "string", to: "string", days: "string", member: "string", full: "boolean" } };
const ADD: Spec = { usage: 'skylight-axi chores add --title "..." --member <name|id> [--date YYYY-MM-DD] [--points N] [--description "..."]', flags: { title: "string", member: "string", date: "string", points: "string", description: "string" } };
const DONE: Spec = { usage: "skylight-axi chores done <id> [--date YYYY-MM-DD] [--time HH:MM] [--member <name|id>]", flags: { date: "string", time: "string", member: "string" } };
const REOPEN: Spec = { usage: "skylight-axi chores reopen <id> [--date YYYY-MM-DD] [--time HH:MM]", flags: { date: "string", time: "string" } };
const UPDATE: Spec = {
  usage: 'skylight-axi chores update <id> [--title T] [--emoji E] [--points N | --no-points] [--routine --slot morning|afternoon|evening | --chore --time HH:MM | --slot S | --time HH:MM] [--member M] [--description D] [--dry-run]',
  flags: { title: "string", emoji: "string", points: "string", "no-points": "boolean", routine: "boolean", chore: "boolean", slot: "string", time: "string", member: "string", description: "string", "dry-run": "boolean" },
};
/** Routine blocks: Skylight allows only 6:00, 14:00 and 20:00. Meal names are aliases (breakfast/lunch/dinner). */
const SLOTS: Record<string, number> = { morning: 6, breakfast: 6, afternoon: 14, lunch: 14, evening: 20, dinner: 20 };
const DELETE: Spec = { usage: "skylight-axi chores delete <id> [--one | --all]", flags: { one: "boolean", all: "boolean" } };

export const CHORES_HELP = `usage: skylight-axi chores <subcommand>
subcommands:
  list [--from D] [--to D | --days N] [--member M] [--full]   default: today
  add --title T --member M [--date D] [--points N] [--description X]
  done <id> [--date D] [--time HH:MM] [--member M]   (--member only for up-for-grabs chores)
  reopen <id> [--date D] [--time HH:MM]
  delete <id> [--one | --all]   (recurring: --one = this occurrence, --all = whole series)
  update <id> [--title T] [--emoji E] [--points N | --no-points] [--member M] [--description D]
              [--routine --slot morning|afternoon|evening]   make it a routine (6:00 / 14:00 / 20:00)
                  slot aliases: breakfast=morning, lunch=afternoon, dinner=evening
              [--slot S]                                     move a routine to another block
              [--chore --time HH:MM]                         make a routine a timed chore again
              [--time HH:MM]                                 retime a chore
              [--dry-run]                                    show the request, send nothing
              Edits the WHOLE SERIES. It also clears today's completion of that chore (see note).
examples:
  skylight-axi chores --days 7 --member Sam
  skylight-axi chores add --title "Feed the dog" --member Sam --points 2
  skylight-axi chores done 987 --date 2026-11-04
  skylight-axi chores update 115854213 --routine --slot afternoon --emoji 🧺
  skylight-axi chores update 70394328 --points 2 --dry-run
notes: <id> may be an occurrence id or a series id. Skylight allows routines only at 6:00, 14:00 and 20:00.
  Editing a series resets that chore's completion for today (points already earned are kept).
`;

export async function choreRows(c: Client, from: string, to: string): Promise<Record<string, unknown>[]> {
  const doc = await c.frameGet("/chores", { after: from, before: to });
  const members = new Map((await loadMembers(c)).map((m) => [m.id, m.label]));
  return asArray(doc?.data).map((r) => {
    const ids = relIds(r, "category");
    return { ...flat(r), member: ids.map((i) => members.get(i) ?? i).join(","), member_id: ids.join(",") };
  });
}

export async function choresCommand(args: string[], c: Client) {
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  const rest = sub === args[0] ? args.slice(1) : args;
  switch (sub) {
    case "list": {
      const { flags } = parseArgs(rest, LIST);
      const { from, to } = dateRange(flags, LIST.usage, 1);
      let rows = await choreRows(c, from, to);
      if (str(flags.member)) {
        const m = await resolveMember(c, str(flags.member)!);
        rows = rows.filter((r) => String(r.member_id).split(",").includes(m.id));
      }
      if (!rows.length) return { chores: `0 chores from ${from} to ${to}`, help: ['Run `skylight-axi chores add --title "..." --member <name|id>` to add one'] };
      const done = rows.filter((r) => r.status === "complete").length;
      return {
        range: `${from}..${to}`,
        count: `${rows.length} (${done} complete)`,
        chores: flags.full ? rows.map(truncRow) : pick(rows, ["id", "summary", "member", "status", "start"]),
        help: ["Run `skylight-axi chores done <id>` to complete one"],
      };
    }
    case "add": {
      const { flags } = parseArgs(rest, ADD);
      if (!str(flags.title)) throw usageError("--title is required", ADD.usage);
      if (!str(flags.member)) throw usageError("--member is required (Skylight chores must be assigned)", ADD.usage);
      const m = await resolveMember(c, str(flags.member)!);
      const points = str(flags.points) === undefined ? undefined : Number(flags.points);
      if (points !== undefined && !Number.isFinite(points)) throw usageError("--points must be a number", ADD.usage);
      const doc = (await c.frameSend("POST", "/chores", {
        summary: str(flags.title),
        category_id: m.id,
        start: str(flags.date) ? requireDate(str(flags.date)!, "date", ADD.usage) : localDate(),
        description: str(flags.description),
        reward_points: points,
      })) as Doc;
      const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
      return { created: { id: r?.id, summary: flags.title, member: m.label } };
    }
    case "done":
    case "reopen": {
      const spec = sub === "done" ? DONE : REOPEN;
      const { pos, flags } = parseArgs(rest, spec);
      requirePosOrFail(pos, 1, spec.usage, "chore id");
      const member = sub === "done" && str(flags.member) ? (await resolveMember(c, str(flags.member)!)).id : undefined;
      const body = {
        status: sub === "done" ? "complete" : "pending",
        instance_date: str(flags.date) ? requireDate(str(flags.date)!, "date", spec.usage) : undefined,
        instance_time: str(flags.time),
        category_id: member,
      };
      await c.frameSend("PUT", `/chores/${enc(pos[0])}/completions`, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
      return { [sub === "done" ? "completed" : "reopened"]: pos[0] };
    }
    case "update":
      return updateChore(rest, c);
    case "delete": {
      const { pos, flags } = parseArgs(rest, DELETE);
      requirePosOrFail(pos, 1, DELETE.usage, "chore id");
      if (flags.one && flags.all) throw usageError("pass only one of --one / --all", DELETE.usage);
      const apply_to = flags.all ? "all" : flags.one ? "one" : undefined;
      return idempotentDelete(`chore ${pos[0]}${apply_to ? ` (${apply_to})` : ""}`, () =>
        c.frameSend("DELETE", `/chores/${enc(pos[0])}`, undefined, apply_to ? { apply_to } : undefined),
      );
    }
    default:
      throw new AxiError(`unknown chores subcommand "${sub}"`, "VALIDATION_ERROR", ["valid: list, add, update, done, reopen, delete"]);
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Strip BYHOUR/BYMINUTE from an RRULE string (keeps everything else, incl. the RRULE: prefix). */
export function stripTime(rule: string): string {
  return rule.split(";").filter((p) => !/^BY(HOUR|MINUTE)=/.test(p)).join(";");
}

/** Build the full-series PUT body from the current series definition plus the requested changes. */
export function buildUpdate(cur: Record<string, unknown>, f: Record<string, string | boolean | undefined>, memberId?: string): { body: Record<string, unknown>; kind: string } {
  const u = UPDATE.usage;
  if (f.routine && f.chore) throw usageError("pass only one of --routine / --chore", u);
  const wasRoutine = cur.routine === true;
  const slotName = str(f.slot);
  if (slotName !== undefined && !(slotName in SLOTS)) throw usageError("--slot must be morning|breakfast, afternoon|lunch or evening|dinner", u);
  if (str(f.time) !== undefined && !HHMM.test(str(f.time)!)) throw usageError("--time must be HH:MM (24h)", u);
  if (str(f.points) !== undefined && f["no-points"]) throw usageError("pass only one of --points / --no-points", u);
  const points = str(f.points) === undefined ? undefined : Number(f.points);
  if (points !== undefined && !Number.isFinite(points)) throw usageError("--points must be a number", u);

  const toRoutine = f.routine === true;
  const toChore = f.chore === true;
  if (toRoutine && !wasRoutine && !slotName) throw usageError("--routine needs --slot morning|afternoon|evening, or breakfast|lunch|dinner (Skylight allows routines only at 6:00, 14:00, 20:00)", u);
  if (toChore && wasRoutine && !str(f.time)) throw usageError("--chore needs --time HH:MM", u);
  if (slotName && toChore) throw usageError("--slot applies to routines; use --time with --chore", u);
  if (slotName && !toRoutine && !wasRoutine) throw usageError("--slot needs --routine (this is a chore)", u);
  if (str(f.time) && (toRoutine || (wasRoutine && !toChore))) throw usageError("routines have no --time; use --slot (6:00 / 14:00 / 20:00)", u);

  const isRoutine = toChore ? false : toRoutine || wasRoutine;
  const rules = (cur.recurrence_set as string[] | undefined) ?? [];
  let rule = rules[0];
  const body: Record<string, unknown> = {
    summary: str(f.title) ?? cur.summary,
    category_id: memberId ?? cur.member_id,
    reward_points: f["no-points"] ? null : points ?? cur.reward_points,
    emoji_icon: str(f.emoji) ?? cur.emoji_icon,
    description: str(f.description) ?? cur.description,
    routine: isRoutine,
  };
  if (isRoutine) {
    const hour = slotName ? SLOTS[slotName] : SLOT_OF(cur.start_time);
    if (rule) body.recurrence_set = [`${stripTime(rule)};BYHOUR=${hour}`];
    // Skylight: start_time "must be blank" on a series that is already a routine.
    if (!wasRoutine) body.start_time = `${String(hour).padStart(2, "0")}:00`;
  } else {
    if (rule) body.recurrence_set = [stripTime(rule)];
    body.start_time = str(f.time) ?? cur.start_time;
  }
  for (const k of Object.keys(body)) if (body[k] === undefined || (body[k] === null && !(k === "reward_points" && f["no-points"]))) delete body[k];
  return { body, kind: isRoutine ? "routine" : "chore" };
}
const SLOT_OF = (t: unknown) => {
  const h = Number(String(t ?? "").slice(0, 2));
  return [6, 14, 20].includes(h) ? h : 14;
};

async function updateChore(rest: string[], c: Client) {
  const { pos, flags } = parseArgs(rest, UPDATE);
  requirePosOrFail(pos, 1, UPDATE.usage, "chore id");
  const changing = ["title", "emoji", "points", "no-points", "routine", "chore", "slot", "time", "member", "description"].some((k) => flags[k] !== undefined);
  if (!changing) throw usageError("nothing to update; pass at least one field flag", UPDATE.usage);
  const series = pos[0].split("-")[0];
  // The list endpoint is the only read; look a week either way so weekly chores are found.
  const rows = await choreRows(c, addDays(localDate(), -1), addDays(localDate(), 7));
  const occ = rows.filter((r) => String(r.series) === series);
  if (!occ.length) throw new AxiError(`no chore series ${series} found in the next 7 days`, "NOT_FOUND", ["Run `skylight-axi chores --days 7 --full` to find ids"]);
  const cur = occ[0];
  const member = str(flags.member) ? (await resolveMember(c, str(flags.member)!)).id : undefined;
  // Validate (and build) before any write.
  if (!member && String(cur.member_id).includes(",")) throw usageError("this chore has several members; pass --member to set one", UPDATE.usage);
  const { body, kind } = buildUpdate(cur, flags, member);
  const path = `/chores/${enc(series)}`;
  const today = localDate();
  const clears = occ.some((r) => r.status === "complete" && String(r.start) === today);
  if (flags["dry-run"]) {
    return { dry_run: true, request: `PUT /frames/{frame}${path}`, body, ...(clears ? { warning: "this would clear today's completion of this chore" } : {}) };
  }
  const doc = (await c.frameSend("PUT", path, body)) as Doc;
  const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
  const a = (r?.attributes ?? {}) as Record<string, unknown>;
  return {
    updated: { series, summary: a.summary ?? body.summary, kind, emoji: a.emoji_icon ?? body.emoji_icon ?? "", points: a.reward_points ?? "", repeat: String((a.recurrence_set as string[] | undefined)?.[0] ?? "").replace("RRULE:", "") },
    ...(clears ? { warning: "today's completion of this chore was cleared by the series edit (points already earned are kept)" } : {}),
  };
}
