import { AxiError } from "axi-sdk-js";
import { parseArgs, requirePosOrFail, str, usageError, type Spec } from "../args.js";
import { enc, flatAll, flat, type Client, type Doc } from "../client.js";
import { idempotentDelete, pick } from "../util.js";

const NONE = (usage: string): Spec => ({ usage, flags: {} });
const CREATE: Spec = { usage: 'skylight-axi lists create "<label>" --kind shopping|to_do [--color "#42D792"]', flags: { kind: "string", color: "string" } };

export const LISTS_HELP = `usage: skylight-axi lists <subcommand>
subcommands:
  [list]                          all lists with item counts
  view <list>                     items in a list (<list> = id or name)
  add <list> <label...>           add an item
  check <list> <item>             mark an item completed (<item> = id or label)
  uncheck <list> <item>           reopen an item
  remove <list> <item>            delete an item
  create "<label>" --kind shopping|to_do [--color HEX]
examples:
  skylight-axi lists view Groceries
  skylight-axi lists add Groceries oat milk
  skylight-axi lists check Groceries "oat milk"
`;

async function findList(c: Client, ref: string) {
  const lists = flatAll(await c.frameGet("/lists"));
  const lc = ref.toLowerCase();
  const hits = lists.filter((l) => String(l.id) === ref);
  const byName = hits.length ? hits : lists.filter((l) => String(l.label).toLowerCase() === lc);
  if (byName.length === 1) return byName[0];
  throw new AxiError(byName.length ? `list "${ref}" is ambiguous` : `no list matches "${ref}"`, "VALIDATION_ERROR", [
    `lists: ${lists.map((l) => `${l.label} (${l.id})`).join(", ") || "none"}`,
  ]);
}
const items = async (c: Client, listId: string) => flatAll(await c.frameGet(`/lists/${enc(listId)}/list_items`));

async function findItem(c: Client, listId: string, ref: string) {
  const all = await items(c, listId);
  const hits = all.filter((i) => String(i.id) === ref);
  const found = hits.length ? hits : all.filter((i) => String(i.label).toLowerCase() === ref.toLowerCase());
  if (found.length === 1) return found[0];
  throw new AxiError(found.length ? `item "${ref}" is ambiguous; use its id` : `no item matches "${ref}"`, "VALIDATION_ERROR", [
    found.length ? `ids: ${found.map((i) => i.id).join(", ")}` : `Run \`skylight-axi lists view ${listId}\` to see items`,
  ]);
}

export async function listsCommand(args: string[], c: Client) {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);
  switch (sub) {
    case "list": {
      parseArgs(rest, NONE("skylight-axi lists"));
      const lists = flatAll(await c.frameGet("/lists"));
      if (!lists.length) return { lists: "0 lists on this frame", help: ['Run `skylight-axi lists create "<label>" --kind shopping` to add one'] };
      return { count: lists.length, lists: pick(lists, ["id", "label", "kind"]), help: ["Run `skylight-axi lists view <list>` to see items"] };
    }
    case "view": {
      const { pos } = parseArgs(rest, NONE("skylight-axi lists view <list>"));
      requirePosOrFail(pos, 1, "skylight-axi lists view <list>", "list id or name");
      const list = await findList(c, pos.join(" "));
      const its = await items(c, String(list.id));
      const open = its.filter((i) => i.status !== "completed").length;
      if (!its.length) return { list: list.label, items: "0 items", help: [`Run \`skylight-axi lists add ${list.label} <label>\` to add one`] };
      return { list: list.label, count: `${its.length} items (${open} open)`, items: pick(its, ["id", "label", "status", "section"]) };
    }
    case "add": {
      const u = "skylight-axi lists add <list> <label...>";
      const { pos } = parseArgs(rest, NONE(u));
      requirePosOrFail(pos, 2, u, "list and item label");
      const list = await findList(c, pos[0]);
      const label = pos.slice(1).join(" ");
      const doc = (await c.request("POST", `/frames/${enc(await c.frameId())}/lists/${enc(String(list.id))}/list_items`, { body: { label } })) as Doc;
      const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
      return { added: { id: r?.id, label, list: list.label } };
    }
    case "check":
    case "uncheck": {
      const u = `skylight-axi lists ${sub} <list> <item>`;
      const { pos } = parseArgs(rest, NONE(u));
      requirePosOrFail(pos, 2, u, "list and item");
      const list = await findList(c, pos[0]);
      const item = await findItem(c, String(list.id), pos.slice(1).join(" "));
      const status = sub === "check" ? "completed" : "pending";
      if (item.status === status) return { item: `${item.label} already ${status} (no-op)` };
      await c.frameSend("PATCH", `/lists/${enc(String(list.id))}/list_items/${enc(String(item.id))}`, { status });
      return { [sub === "check" ? "checked" : "unchecked"]: { id: item.id, label: item.label } };
    }
    case "remove": {
      const u = "skylight-axi lists remove <list> <item>";
      const { pos } = parseArgs(rest, NONE(u));
      requirePosOrFail(pos, 2, u, "list and item");
      const list = await findList(c, pos[0]);
      let item;
      try {
        item = await findItem(c, String(list.id), pos.slice(1).join(" "));
      } catch (e) {
        if (e instanceof AxiError && e.message.startsWith("no item")) return { removed: `${pos.slice(1).join(" ")} (not in list, no-op)` };
        throw e;
      }
      return idempotentDelete(`item ${item.id} (${item.label})`, () => c.frameSend("DELETE", `/lists/${enc(String(list.id))}/list_items/${enc(String(item.id))}`));
    }
    case "create": {
      const { pos, flags } = parseArgs(rest, CREATE);
      requirePosOrFail(pos, 1, CREATE.usage, "list label");
      const kind = str(flags.kind);
      if (kind !== "shopping" && kind !== "to_do") throw usageError("--kind must be shopping or to_do", CREATE.usage);
      const doc = (await c.frameSend("POST", "/lists", { label: pos.join(" "), color: str(flags.color) ?? "#42D792", kind })) as Doc;
      const r = Array.isArray(doc?.data) ? doc.data[0] : doc?.data;
      return { created: r ? pick([flat(r)], ["id", "label", "kind"])[0] : pos.join(" ") };
    }
    default:
      throw new AxiError(`unknown lists subcommand "${sub}"`, "VALIDATION_ERROR", ["valid: list, view, add, check, uncheck, remove, create"]);
  }
}
