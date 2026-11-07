---
name: skylight-axi
description: Read and manage the user's Skylight family calendar from the shell - events, chores, shared lists (grocery/to-do), meal plan, task box, reward points. Use when asked about the family calendar, what's on today/this week, adding or completing chores, or editing shopping/to-do lists.
---

# skylight-axi

Run `skylight-axi` with no arguments first: it prints today's events and chore progress. Credentials come from `~/.config/skylight-axi/.env` or SKYLIGHT_* env vars. Output is TOON; errors are on stdout with a `help` line saying what to run next.

usage: skylight-axi [command]
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

usage: skylight-axi events <subcommand>
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

usage: skylight-axi chores <subcommand>
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
              [--days mon-thu|weekdays|daily|MO,TU,..]       change which days it repeats
              [--dry-run]                                    show the request, send nothing
              Edits the WHOLE SERIES. It also clears today's completion of that chore (see note).
examples:
  skylight-axi chores --days 7 --member Sam
  skylight-axi chores add --title "Feed the dog" --member Sam --points 2
  skylight-axi chores done 987 --date 2026-11-04
  skylight-axi chores update 115854213 --routine --slot afternoon --emoji 🧺
  skylight-axi chores update 70394328 --points 2 --dry-run
  skylight-axi chores update 78020488 --days mon-thu
notes: <id> may be an occurrence id or a series id. Skylight allows routines only at 6:00, 14:00 and 20:00.
  Editing a series resets that chore's completion for today (points already earned are kept).

usage: skylight-axi lists <subcommand>
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

usage: skylight-axi tasks <subcommand>   (the Skylight task box)
  [list]
  add "<title>" [--points N] [--emoji X]
  delete <id>

usage: skylight-axi api <GET|POST|PUT|PATCH|DELETE> </path> [--query k=v]... [--body '<json>']
Raw Skylight API call (JSON:API response, truncated). Paths are relative to /api.
Use "{frame}" in the path for the resolved frame id.
examples:
  skylight-axi api GET /frames/{frame}/devices
  skylight-axi api PUT /frames/{frame}/lists/1 --body '{"label":"Groceries"}'

usage: skylight-axi discover <file.har>... [--new] [--show "<METHOD> <path>"]
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

usage: skylight-axi meals [--from YYYY-MM-DD] [--to YYYY-MM-DD | --days N]   (default: next 7 days)

usage: skylight-axi members   list family members with ids

usage: skylight-axi points   reward point balances

usage: skylight-axi auth   show credential source and token cache path (no network)

usage: skylight-axi setup hooks [--project]   install a SessionStart hook for Claude Code/Codex/OpenCode
