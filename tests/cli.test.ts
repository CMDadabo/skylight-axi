import { describe, expect, it, vi } from "vitest";
import { parseArgs, dateRange, addDays } from "../src/args.js";
import { Client } from "../src/client.js";
import { eventsCommand } from "../src/commands/events.js";
import { choresCommand } from "../src/commands/chores.js";
import { listsCommand } from "../src/commands/lists.js";
import { eventRows } from "../src/util.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fakeClient(routes: Record<string, (init: RequestInit, url: URL) => Response>) {
  const calls: string[] = [];
  const f = vi.fn(async (u: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(u));
    const key = `${init.method} ${url.pathname.replace("/api", "")}`;
    calls.push(key);
    const h = routes[key];
    if (!h) return json({ errors: [{ detail: "no route" }] }, 404);
    return h(init, url);
  });
  const auth = { token: async () => "t", renew: async () => "t" } as never;
  const c = new Client({ baseUrl: "https://x/api", authBaseUrl: "https://x", frameId: "9" }, auth, f as never);
  return { c, calls, f };
}

describe("args", () => {
  const spec = { usage: "u", flags: { from: "string" as const, full: "boolean" as const } };
  it("rejects unknown flags with valid list", () => {
    expect(() => parseArgs(["--frm", "x"], spec)).toThrow(/unknown flag --frm/);
  });
  it("parses flags and positionals", () => {
    expect(parseArgs(["a", "--from=2026-01-01", "--full"], spec)).toEqual({ pos: ["a"], flags: { from: "2026-01-01", full: true } });
  });
  it("computes ranges", () => {
    expect(dateRange({ from: "2026-11-04", days: "3" }, "u", 7)).toEqual({ from: "2026-11-04", to: "2026-11-06" });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => dateRange({ from: "nope" }, "u", 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe("events", () => {
  it("lists with member labels resolved from included categories", async () => {
    const { c } = fakeClient({
      "GET /frames/9/calendar_events": () =>
        json({
          data: [{ id: "1", type: "calendar_event", attributes: { summary: "Soccer", starts_at: "2026-11-05T17:00" }, relationships: { categories: { data: [{ id: "7", type: "category" }] } } }],
          included: [{ id: "7", type: "category", attributes: { label: "Sam" } }],
        }),
    });
    const out: any = await eventsCommand(["list", "--from", "2026-11-05", "--days", "1"], c);
    expect(out.count).toBe(1);
    expect(out.events[0]).toEqual({ id: "1", summary: "Soccer", starts_at: "2026-11-05T17:00", ends_at: "", members: "Sam" });
  });
  it("sends an exclusive date_max (to+1) and a timezone", async () => {
    let q: URL | undefined;
    const { c } = fakeClient({ "GET /frames/9/calendar_events": (_i, url) => ((q = url), json({ data: [] })) });
    await eventsCommand(["list", "--from", "2026-11-04", "--to", "2026-11-04"], c);
    expect(q!.searchParams.get("date_min")).toBe("2026-11-04");
    expect(q!.searchParams.get("date_max")).toBe("2026-11-05");
    expect(q!.searchParams.get("timezone")).toBeTruthy();
  });
  it("states empty explicitly", async () => {
    const { c } = fakeClient({ "GET /frames/9/calendar_events": () => json({ data: [] }) });
    const out: any = await eventsCommand([], c);
    expect(out.events).toMatch(/^0 events/);
  });
  it("delete is idempotent on 404", async () => {
    const { c } = fakeClient({});
    const out: any = await eventsCommand(["delete", "5"], c);
    expect(out.deleted).toMatch(/no-op/);
  });
  it("create requires --title before any request", async () => {
    const { c, calls } = fakeClient({});
    await expect(eventsCommand(["create", "--start", "x"], c)).rejects.toThrow(/--title is required/);
    expect(calls).toEqual([]);
  });
  it("eventRows handles missing includes", () => {
    expect(eventRows(undefined)).toEqual([]);
  });
});

describe("chores", () => {
  it("resolves member by name and posts category_id", async () => {
    let sent: any;
    const { c } = fakeClient({
      "GET /frames/9/categories": () => json({ data: [{ id: "7", type: "category", attributes: { label: "Sam" } }] }),
      "POST /frames/9/chores": (init) => ((sent = JSON.parse(String(init.body))), json({ data: { id: "42", type: "chore", attributes: {} } })),
    });
    const out: any = await choresCommand(["add", "--title", "Dishes", "--member", "sam"], c);
    expect(sent.category_id).toBe("7");
    expect(out.created.id).toBe("42");
  });
  it("lists the unknown member options on a bad --member", async () => {
    const { c } = fakeClient({ "GET /frames/9/categories": () => json({ data: [{ id: "7", type: "category", attributes: { label: "Sam" } }] }) });
    await expect(choresCommand(["add", "--title", "x", "--member", "zed"], c)).rejects.toThrow(/no member matches/);
  });
});

describe("lists", () => {
  it("check is a no-op when already completed", async () => {
    const { c, calls } = fakeClient({
      "GET /frames/9/lists": () => json({ data: [{ id: "1", type: "list", attributes: { label: "Groceries" } }] }),
      "GET /frames/9/lists/1/list_items": () => json({ data: [{ id: "5", type: "i", attributes: { label: "milk", status: "completed" } }] }),
    });
    const out: any = await listsCommand(["check", "groceries", "Milk"], c);
    expect(out.item).toMatch(/no-op/);
    expect(calls.some((x) => x.startsWith("PATCH"))).toBe(false);
  });
});

import { aggregate, normalizePath } from "../src/commands/discover.js";
describe("discover", () => {
  it("normalizes ids, composite ids and dates", () => {
    expect(normalizePath("/frames/1234567/calendar_events/1111111111-1700000000")).toBe("/frames/{frame}/calendar_events/{calendar_event_id}");
    expect(normalizePath("/frames/1/meals/sittings/55555/instances/2026-11-04")).toBe("/frames/{frame}/meals/sittings/{sitting_id}/instances/{date}");
    expect(normalizePath("/frames/1/lists")).toBe("/frames/{frame}/lists");
  });
  it("groups calls and never keeps body/query values", () => {
    const entry = (url: string, status: number, res: unknown, req?: unknown) => ({
      request: { method: "POST", url, postData: req ? { text: JSON.stringify(req) } : undefined },
      response: { status, content: { text: JSON.stringify(res) } },
    });
    const { apiCalls, endpoints } = aggregate([
      entry("https://app.ourskylight.com/api/frames/9/chores?token=SECRET", 200, { data: { type: "chore", id: "1", attributes: { summary: "Private" } } }, { password: "hunter2" }),
      entry("https://other.example/api/x", 200, {}),
    ]);
    expect(apiCalls).toBe(1);
    const dump = JSON.stringify([...endpoints.values()].map((a) => ({ ...a, statuses: [...a.statuses], query: [...a.query] })));
    expect(dump).not.toMatch(/SECRET|hunter2|Private/);
    expect(dump).toMatch(/"password":"string"/);
  });
});

import { buildUpdate, stripTime } from "../src/commands/chores.js";
describe("chores update", () => {
  const chore = { series: "9", summary: "Fold", member_id: "7", reward_points: 4, emoji_icon: null, description: null, routine: false, start_time: "15:45", recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1"] };
  const routine = { ...chore, routine: true, start_time: "14:00", recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1;WKST=MO;BYHOUR=14"] };
  it("chore -> routine sets BYHOUR and start_time, keeps points", () => {
    const { body, kind } = buildUpdate(chore, { routine: true, slot: "afternoon", emoji: "🧺" });
    expect(kind).toBe("routine");
    expect(body).toMatchObject({ routine: true, start_time: "14:00", reward_points: 4, emoji_icon: "🧺", category_id: "7", recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=14"] });
  });
  it("already-routine edits omit start_time (API: must be blank) and can move slot", () => {
    const { body } = buildUpdate(routine, { slot: "evening" });
    expect(body).not.toHaveProperty("start_time");
    expect(body.recurrence_set).toEqual(["RRULE:FREQ=DAILY;INTERVAL=1;WKST=MO;BYHOUR=20"]);
  });
  it("routine -> chore needs --time and drops BYHOUR", () => {
    expect(() => buildUpdate(routine, { chore: true })).toThrow(/--time/);
    const { body } = buildUpdate(routine, { chore: true, time: "16:30" });
    expect(body).toMatchObject({ routine: false, start_time: "16:30", recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1;WKST=MO"] });
  });
  it("validates before building", () => {
    expect(() => buildUpdate(chore, { routine: true })).toThrow(/--slot/);
    expect(() => buildUpdate(chore, { routine: true, slot: "noon" })).toThrow(/morning, afternoon or evening/);
    expect(() => buildUpdate(routine, { time: "09:00" })).toThrow(/no --time/);
    expect(() => buildUpdate(chore, { points: "x" })).toThrow(/number/);
  });
  it("--no-points sends null; null fields are otherwise dropped", () => {
    expect(buildUpdate(chore, { "no-points": true }).body.reward_points).toBeNull();
    expect(buildUpdate(chore, { title: "x" }).body).not.toHaveProperty("emoji_icon");
  });
  it("stripTime", () => expect(stripTime("RRULE:FREQ=WEEKLY;BYHOUR=6;BYDAY=MO")).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO"));
  it("dry-run sends no PUT and warns when today's completion would clear", async () => {
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const { c, calls } = fakeClient({
      "GET /frames/9/categories": () => json({ data: [{ id: "7", type: "category", attributes: { label: "Sam" } }] }),
      "GET /frames/9/chores": () => json({ data: [{ id: `9-${d}`, type: "chore", attributes: { series: "9", summary: "Fold", status: "complete", start: d, routine: false, reward_points: 4, recurrence_set: ["RRULE:FREQ=DAILY;INTERVAL=1"], start_time: "15:45" }, relationships: { category: { data: { id: "7", type: "category" } } } }] }),
    });
    const out: any = await choresCommand(["update", `9-${d}`, "--routine", "--slot", "afternoon", "--dry-run"], c);
    expect(out.dry_run).toBe(true);
    expect(out.warning).toMatch(/clear today's completion/);
    expect(calls.some((x) => x.startsWith("PUT"))).toBe(false);
  });
  it("rejects bad flags before any request", async () => {
    const { c, calls } = fakeClient({});
    await expect(choresCommand(["update", "9", "--bogus"], c)).rejects.toThrow(/unknown flag/);
    await expect(choresCommand(["update", "9"], c)).rejects.toThrow(/nothing to update/);
    expect(calls).toEqual([]);
  });
});
