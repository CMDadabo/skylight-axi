# skylight-axi

Agent-ergonomic CLI ([AXI](https://github.com/kunchenguid/axi)) for [Skylight Calendar](https://ourskylight.com), built on the API work in [skylight-mcp](https://github.com/chrischall/skylight-mcp). TOON output on stdout, minimal default fields, definitive empty states, idempotent mutations, structured errors, and flags validated before any network call.

## Auth

Put these in `~/.config/skylight-axi/.env` (or point `SKYLIGHT_ENV_FILE` elsewhere; real env vars take precedence), or export them. Set `SKYLIGHT_EMAIL` + `SKYLIGHT_PASSWORD`, or `SKYLIGHT_REFRESH_TOKEN`. Optional: `SKYLIGHT_FRAME_ID` (required only if the account has several frames), `SKYLIGHT_BASE_URL`, `SKYLIGHT_TOKEN_FILE`.
Login/refresh reuse `skylight-mcp/auth`. Tokens are cached (0600) at `~/.config/skylight-axi/tokens.json`, bound to the credential that minted them, and refreshed ahead of expiry or on a 401.

## Usage

```
skylight-axi                       # today's events + chore progress
skylight-axi events --days 7
skylight-axi events create --title "Dentist" --start 2026-11-10T15:00:00 --member Sam
skylight-axi chores add --title "Dishes" --member Sam --points 2
skylight-axi chores done <id>
skylight-axi lists add Groceries oat milk
skylight-axi meals | members | points | tasks
skylight-axi api GET /frames/{frame}/devices     # escape hatch for anything else
skylight-axi discover traffic.har --new           # find API endpoints the web app uses that this CLI doesn't cover
skylight-axi setup hooks                         # SessionStart context for Claude Code/Codex/OpenCode
```

Not covered (use `api`, or the MCP server): photos/albums/messages upload, calendar-account linking, AI meal/activity generation, member invites, e-mail event invitations.

## API discovery

`skylight-axi discover <file.har>...` applies the HAR-based method from [TheEagleByte/skylight-api](https://github.com/TheEagleByte/skylight-api): export a HAR from browser DevTools while using app.ourskylight.com, and it lists each endpoint (IDs normalized, `{frame}` for the frame id), status codes, query-param names, and whether this CLI already has a command for it. `--show "<METHOD> <path>"` prints request/response shape (JSON:API type, attribute names and types). A HAR contains bearer tokens and personal data, so the command prints structure only, never header, query or body values. Try new endpoints with `skylight-axi api`.
