// Generates skills/skylight-axi/SKILL.md from the CLI's own help text (single source of truth).
// Usage: tsx scripts/gen-skill.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { COMMAND_HELP, TOP_LEVEL_HELP } from "../src/cli.js";

const out = new URL("../skills/skylight-axi/SKILL.md", import.meta.url);
const body = `---
name: skylight-axi
description: Read and manage the user's Skylight family calendar from the shell - events, chores, shared lists (grocery/to-do), meal plan, task box, reward points. Use when asked about the family calendar, what's on today/this week, adding or completing chores, or editing shopping/to-do lists.
---

# skylight-axi

Run \`skylight-axi\` with no arguments first: it prints today's events and chore progress. Credentials come from \`~/.config/skylight-axi/.env\` or SKYLIGHT_* env vars. Output is TOON; errors are on stdout with a \`help\` line saying what to run next.

${TOP_LEVEL_HELP}
${Object.values(COMMAND_HELP).join("\n")}`;

if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== body) {
    console.error("SKILL.md is stale; run `npm run gen:skill`");
    process.exit(1);
  }
} else writeFileSync(out, body);
