import { AxiError } from "axi-sdk-js";
import { addDays, dateRange, localTimezone, parseArgs, requirePosOrFail, str, usageError, type Spec } from "../args.js";
import { enc, flat, type Client, type Doc } from "../client.js";
import { eventRows, idempotentDelete, pick, resolveMember, truncRow } from "../util.js";

const INCLUDE = "categories";
const COLS = ["id", "summary", "starts_at", "ends_at", "members"];

const LIST: Spec = {
  usage: "skylight-axi events [list] [--from YYYY-MM-DD] [--to YYYY-MM-DD | --days N] [--full]",
  flags: { from: "string", to: "string", days: "string", full: "boolean" },
};
const CREATE: Spec = {
  usage: 'skylight-axi events create --title "..." --start <ISO> [--end <ISO>] [--all-day] [--location "..."] [--description "..."] [--member <name|id>]... [--rrule "FREQ=WEEKLY"]',
  flags: { title: "string", start: "string", end: "string", "all-day": "boolean", location: "string", description: "string", member: "string", rrule: "string", timezone: "string" },
  renamed: { summary: "use --title", invite: "inviting people by e-mail is not supported by skylight-axi" },
};
const UPDATE: Spec = {
  usage: "skylight-axi events update <id> [--title ..] [--start ..] [--end ..] [--location ..] [--description ..] [--member <name|id>] [--rrule ..]",
  flags: { title: "string", start: "string", end: "string", "all-day": "boolean", location: "string", description: "string", member: "string", rrule: "string", timezone: "string" },
};
const DELETE: Spec = { usage: "skylight-axi events delete <id>", flags: {} };

/**
 * LIVE-VERIFIED: the API's `date_max` is exclusive (date_min == date_max returns nothing), and
 * without `timezone` it returns UTC timestamps that shift events across day boundaries.
 * `to` here is inclusive, so send to+1 and the local zone.
 */
export async function fetchEvents(c: Client, from: string, to: string) {
  return eventRows(await c.frameGet("/calendar_events", { date_min: from, date_max: addDays(to, 1), timezone: localTimezone(), include: INCLUDE }));
}

export const EVENTS_HELP = `usage: skylight-axi events <subcommand>
subcommands:
  list [--from D] [--to D | --days N] [--full]   default: today + 6 days
  create --title T --start ISO [--end ISO] [--all-day] [--location L] [--description D] [--member M]... [--rrule R]
  update <id> [--title T] [--start ISO] ...
  delete <id>
examples:
  skylight-axi events --days 3
  skylight-axi events create --title "Dentist" --start 2026-11-10T15:00:00 --end 2026-11-10T16:00:00 --member Sam
  skylight-axi events delete 12345
note: --member may be repeated; E-mail invitations are not supported.
`;

function body(f: Record<string, string | boolean | undefined>, members: string[]): Record<string, unknown> {
  const b: Record<string, unknown> = {
    summary: str(f.title),
    starts_at: str(f.start),
    ends_at: str(f.end),
    all_day: f["all-day"] === true ? true : undefined,
    location: str(f.location),
    description: str(f.description),
    rrule: str(f.rrule),
    timezone: str(f.timezone),
    category_ids: members.length ? members : undefined,
  };
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
}

/** `--member` may repeat; the generic parser keeps the last, so pull all occurrences. */
function allMembers(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--member" && args[i + 1]) out.push(args[++i]);
    else if (args[i].startsWith("--member=")) out.push(args[i].slice(9));
  }
  return out;
}

export async function eventsCommand(args: string[], c: Client) {
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  const rest = sub === args[0] ? args.slice(1) : args;
  switch (sub) {
    case "list": {
      const { flags } = parseArgs(rest, LIST);
      const { from, to } = dateRange(flags, LIST.usage, 7);
      const rows = await fetchEvents(c, from, to);
      rows.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
      if (!rows.length) return { events: `0 events from ${from} to ${to}`, help: ["Run `skylight-axi events create --title \"...\" --start <ISO>` to add one"] };
      return {
        range: `${from}..${to}`,
        count: rows.length,
        events: flags.full ? rows.map(truncRow) : pick(rows, COLS),
        help: ["Run `skylight-axi events update <id> --title \"...\"` to change one", "Run `skylight-axi events list --full` for all fields"],
      };
    }
    case "create": {
      const { flags } = parseArgs(rest, CREATE);
      if (!str(flags.title)) throw usageError("--title is required", CREATE.usage);
      if (!str(flags.start)) throw usageError("--start is required", CREATE.usage);
      const ids = await Promise.all(allMembers(rest).map((m) => resolveMember(c, m)));
      const doc = (await c.frameSend("POST", "/calendar_events", body(flags, ids.map((m) => m.id)))) as Doc;
      const r = (Array.isArray(doc?.data) ? doc.data[0] : doc?.data)!;
      return { created: { id: r?.id, summary: r?.attributes?.summary ?? flags.title, starts_at: r?.attributes?.starts_at ?? flags.start } };
    }
    case "update": {
      const { pos, flags } = parseArgs(rest, UPDATE);
      requirePosOrFail(pos, 1, UPDATE.usage, "event id");
      const ids = await Promise.all(allMembers(rest).map((m) => resolveMember(c, m)));
      const b = body(flags, ids.map((m) => m.id));
      if (!Object.keys(b).length) throw usageError("nothing to update; pass at least one field flag", UPDATE.usage);
      const doc = (await c.frameSend("PUT", `/calendar_events/${enc(pos[0])}`, b)) as Doc;
      const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
      return { updated: r ? pick([flat(r)], COLS.slice(0, 4))[0] : { id: pos[0] } };
    }
    case "delete": {
      const { pos } = parseArgs(rest, DELETE);
      requirePosOrFail(pos, 1, DELETE.usage, "event id");
      return idempotentDelete(`event ${pos[0]}`, () => c.frameSend("DELETE", `/calendar_events/${enc(pos[0])}`));
    }
    default:
      throw new AxiError(`unknown events subcommand "${sub}"`, "VALIDATION_ERROR", ["valid: list, create, update, delete"]);
  }
}
