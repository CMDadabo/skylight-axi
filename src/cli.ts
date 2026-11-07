import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError, installSessionStartHooks, runAxiCli } from "axi-sdk-js";
import { localDate, parseArgs } from "./args.js";
import { tokenFile } from "./auth.js";
import { Client } from "./client.js";
import { choreRows, CHORES_HELP, choresCommand } from "./commands/chores.js";
import { DISCOVER_HELP, discoverCommand } from "./commands/discover.js";
import { EVENTS_HELP, eventsCommand, fetchEvents } from "./commands/events.js";
import { LISTS_HELP, listsCommand } from "./commands/lists.js";
import { API_HELP, apiCommand, mealsCommand, membersCommand, pointsCommand, TASKS_HELP, tasksCommand } from "./commands/misc.js";
import { pick } from "./util.js";
import { VERSION } from "./version.js";

export const DESCRIPTION = "Read and manage a Skylight family calendar: events, chores, lists, meals, rewards";

export const TOP_LEVEL_HELP = `usage: skylight-axi [command]
commands[11]:
  events [list|create|update|delete]   calendar events (default: next 7 days)
  chores [list|add|done|reopen|delete] chores (default: today)
  lists [view|add|check|uncheck|remove|create]   shared lists
  tasks [list|add|delete]              task box
  meals [--from D --to D]              meal plan
  members                              family members (chore/event assignees)
  points                               reward point balances
  api <METHOD> <path>                  raw API call
  discover <file.har>...               find API endpoints in a browser HAR capture
  auth                                 show credential source / token cache
  setup hooks                          install session-start context hook
auth: set SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD (or SKYLIGHT_REFRESH_TOKEN); optional SKYLIGHT_FRAME_ID
flags: --help on any command; dates are YYYY-MM-DD
`;

let client: Client | undefined;
const getClient = () => (client ??= Client.create());
/** Resolves credentials on first use, so flag/usage errors surface before any auth error. */
const lazyClient = new Proxy({} as Client, {
  get(_t, prop) {
    const real = getClient() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? v.bind(real) : v;
  },
});

export const COMMAND_HELP: Record<string, string> = {
  events: EVENTS_HELP,
  chores: CHORES_HELP,
  lists: LISTS_HELP,
  tasks: TASKS_HELP,
  api: API_HELP,
  discover: DISCOVER_HELP,
  meals: "usage: skylight-axi meals [--from YYYY-MM-DD] [--to YYYY-MM-DD | --days N]   (default: next 7 days)\n",
  members: "usage: skylight-axi members   list family members with ids\n",
  points: "usage: skylight-axi points   reward point balances\n",
  auth: "usage: skylight-axi auth   show credential source and token cache path (no network)\n",
  setup: "usage: skylight-axi setup hooks [--project]   install a SessionStart hook for Claude Code/Codex/OpenCode\n",
};

async function home() {
  let c: Client;
  try {
    c = getClient();
  } catch (e) {
    if (e instanceof AxiError && e.code === "NO_AUTH") {
      return { auth: "not configured", help: ["Set SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD (or SKYLIGHT_REFRESH_TOKEN), then re-run `skylight-axi`"] };
    }
    throw e;
  }
  const today = localDate();
  const [frame, events, chores] = await Promise.all([c.frameInfo(), fetchEvents(c, today, today), choreRows(c, today, today)]);
  events.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const done = chores.filter((r) => r.status === "complete").length;
  return {
    frame: `${frame.name ?? "?"} (${frame.id})`,
    today,
    events: events.length ? pick(events, ["id", "summary", "starts_at", "members"]) : "0 events today",
    chores: chores.length ? `${done} of ${chores.length} complete` : "0 chores today",
    help: [
      "Run `skylight-axi events --days 7` for the week ahead",
      "Run `skylight-axi chores` to see today's chores",
      "Run `skylight-axi lists` for shared lists",
    ],
  };
}

/** Load credentials from ~/.config/skylight-axi/.env (or SKYLIGHT_ENV_FILE). Real env vars win. */
function loadEnvFile(): void {
  const file = process.env.SKYLIGHT_ENV_FILE ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "skylight-axi", ".env");
  try {
    process.loadEnvFile(file); // does not override variables already set
  } catch (e) {
    // A missing default file is normal; a missing explicit one is a mistake worth surfacing.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || process.env.SKYLIGHT_ENV_FILE) {
      process.stderr.write(`warning: could not read env file ${file}: ${(e as Error).message}\n`);
    }
  }
}

export async function main() {
  loadEnvFile();
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (cmd) => COMMAND_HELP[cmd],
    home,
    commands: {
      events: (a) => eventsCommand(a, lazyClient),
      chores: (a) => choresCommand(a, lazyClient),
      lists: (a) => listsCommand(a, lazyClient),
      tasks: (a) => tasksCommand(a, lazyClient),
      meals: (a) => mealsCommand(a, lazyClient),
      members: (a) => membersCommand(a, lazyClient),
      points: (a) => pointsCommand(a, lazyClient),
      discover: (a) => discoverCommand(a),
      api: (a) => apiCommand(a, lazyClient),
      auth: (a) => {
        parseArgs(a, { usage: "skylight-axi auth", flags: {} });
        const src = process.env.SKYLIGHT_REFRESH_TOKEN ? "SKYLIGHT_REFRESH_TOKEN" : process.env.SKYLIGHT_EMAIL && process.env.SKYLIGHT_PASSWORD ? "SKYLIGHT_EMAIL/PASSWORD" : "none";
        return { auth: { source: src, token_cache: tokenFile() }, ...(src === "none" ? { help: ["Set SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD (or SKYLIGHT_REFRESH_TOKEN)"] } : {}) };
      },
      setup: (a) => {
        if (a[0] !== "hooks") throw new AxiError("unknown setup target", "VALIDATION_ERROR", ["Run `skylight-axi setup hooks [--project]`"]);
        const { flags } = parseArgs(a.slice(1), { usage: "skylight-axi setup hooks [--project]", flags: { project: "boolean" } });
        installSessionStartHooks({ marker: "skylight-axi", binaryNames: ["skylight-axi"], scope: flags.project ? "project" : "user" });
        return { setup: `session hooks installed or already up to date (${flags.project ? "project" : "user"} scope)` };
      },
    },
  });
}
