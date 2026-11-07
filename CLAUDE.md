# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`skylight-axi` is an AXI (agent-ergonomic CLI) for Skylight Calendar, built on the endpoint knowledge in [chrischall/skylight-mcp](https://github.com/chrischall/skylight-mcp). Output is TOON on stdout via `axi-sdk-js`. Read the `axi` skill (`.claude/skills/axi`) before changing output formats, errors, or help text; its rules are enforced here (minimal default fields, definitive empty states, idempotent mutations, errors on stdout, unknown flags rejected with exit 2, validation before any network call).

## Commands

- `npm run dev -- <args>` — run from source via tsx (e.g. `npm run dev -- events --days 3`)
- `npm run build` — tsc to `dist/`. The globally linked `skylight-axi` runs `dist/`, so rebuild after edits
- `npm test` — vitest (all mocked, no network). Single test: `npx vitest run -t '<name substring>'`
- `npm run typecheck`
- `npm run gen:skill` / `npm run check:skill` — regenerate / verify `skills/skylight-axi/SKILL.md`. It is generated from `TOP_LEVEL_HELP` and `COMMAND_HELP` in `src/cli.ts`; never edit it by hand, and rerun after changing any help text

## Architecture

- `bin/skylight-axi.ts` answers `--version` through `axi-sdk-js/fast-path` using the leaf module `src/version.ts`, then dynamically imports `src/cli.ts`. Keep `version.ts` free of imports so the fast path stays fast.
- `src/cli.ts` wires `runAxiCli`: command table, per-command help, the home view (today's events + chore progress), `auth`, `setup hooks`. Commands receive a **lazy Proxy client**, so credentials are resolved only on first use; this is what lets flag/usage errors surface before any auth error. Don't call `getClient()` before `parseArgs`.
- `src/args.ts` is a small per-command flag parser (`Spec` = valid flags + usage). Unknown flags throw `AxiError(..., "VALIDATION_ERROR")`, which the SDK maps to exit 2. Also holds date-range and timezone helpers.
- `src/auth.ts` loads config from env, and `~/.config/skylight-axi/.env` (or `SKYLIGHT_ENV_FILE`) is loaded in `cli.ts`. Login/refresh come from `skylight-mcp/auth`. Tokens are cached at `~/.config/skylight-axi/tokens.json` (0600), bound to a digest of the credential that minted them. Skylight refresh tokens are single-use and rotate, so a failed cache write only warns on stderr.
- `src/client.ts` — fetch wrapper: adds the `skylight-api-version: 2026-05-01` header (required or some endpoints 422), one retry on 401 after re-auth, 429 backoff, and translates HTTP errors into `AxiError`s. `SKYLIGHT_FRAME_ID` skips the `/frames` lookup.
- `src/commands/*.ts` — one module per area (`events`, `chores`, `lists`, `misc` = members/points/tasks/meals/api, `discover`). Responses are JSON:API; use `flat()`/`flatAll()` and resolve relationships (member names, event categories) from `relationships`/`included` explicitly.
- `src/commands/discover.ts` parses browser HAR files. It must print structure only (paths, key names, types), never header/query/body values; a unit test guards this. Its `COVERED` table is hand-maintained: update it when adding a command that calls a new endpoint.

## Live-API facts that are easy to get wrong (all verified against a real account)

- **Event queries:** `date_max` is exclusive and, without `timezone`, results are UTC. `fetchEvents` sends `to+1` and the local zone (`SKYLIGHT_TIMEZONE` overrides). Chores and meals ranges behave inclusively.
- **Routines vs chores:** distinguished by the `routine` attribute. Routines may only run at `BYHOUR` 6, 14 or 20 (one `BYHOUR`, set in the RRULE; the server 422s otherwise). `start_time` must be omitted when the series is already a routine, and sent when converting a chore to a routine.
- **Series edits:** `PUT /frames/{f}/chores/{seriesId}` takes the *full* chore body, not a patch, and resets that chore's completion for today (earned points are kept). `chores update` builds the body from the current definition (`buildUpdate`) and supports `--dry-run`. The routine→chore path (`--chore`) is untested against the live API.
- **Chore ids:** occurrence ids look like `<series>-<date>[-<HHMM>]`; the series id is the part before the first `-`. A chore's assignee exists only in `relationships.category`.
- **Error details:** Skylight 422 bodies explain the problem (`{"errors":{field:[msg]}}`); `httpError` in `client.ts` surfaces them. Keep that, since the messages are how new constraints get discovered.
- The `api` command truncates output at 4000 chars; don't count rows from it.

## Scope

Not wrapped (use `skylight-axi api ...` or the MCP server): photo/avatar uploads, messages/albums, calendar-account linking, AI meal/activity generation, member invites, and e-mail event invitations (deliberately omitted because they can't be undone).
