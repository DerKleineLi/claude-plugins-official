# CLAUDE_README — Discord channel plugin

Project memory for future-you (Claude). User-facing docs are in `README.md` and `ACCESS.md`. **Read this before editing.**

## What this is

The user's Discord channel plugin — an MCP server (`server.ts`, single file ~1k LOC) that bridges Discord to a Claude Code session. Originally forked from [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official); the active branch is `local/main` of `DerKleineLi/claude-plugins-official` (the user's fork). Local edits live on top of upstream.

## Live deployment

NOT installed via the marketplace. Loaded directly:

- `~/tools/clive` invokes `claude` with `--mcp-config ~/.claude/clive_channels.json` and `--plugin-dir ~/workspace/claude-plugins-official/external_plugins/discord`.
- The MCP entry `clive_channels.json → mcpServers.discord` runs `bun start` in this directory.
- Bot token lives at `~/.claude/channels/discord/.env` as `DISCORD_BOT_TOKEN=…`. (It's *also* injected via the `env` field in `clive_channels.json` for redundancy.)
- Runtime state: `~/.claude/channels/discord/access.json`, plus `inbox/` for downloaded attachments and `approved/` for pairing-confirmation markers.

This unification (bare MCP server + `--plugin-dir`, no marketplace) was settled on **2026-05-07**. See `~/.claude/projects/-home-hli/memory/telegram.md` for the rationale — the same shape applies here.

## Local patches (post-fork)

- **2026-05-08** — Phase 1 server-management tools (`create_channel`, `delete_channel`, `modify_channel`, `create_thread`, `start_forum_post`, `bulk_delete_messages`, `pin_message`, `unpin_message`, `get_audit_log`), gated on `mgmtEnabled` in `access.json`.
- **2026-05-08** — Forward `reply_to_message_id` (and `reply_to_user`/`reply_to_user_id`/`reply_to_text`) on inbound channel blocks. Parity with telegram fork commit `bfeb345`.
- **2026-05-08** — Forward emoji reactions (`messageReactionAdd`/`Remove` → `<channel … reaction="…">` block). Parity with telegram fork commit `c90b380`.

## Architecture rationale

Single-user, single-server, private bot. Trust model:

- **Chat ops** (reply/react/edit/fetch/download) are gated by `access.json` per-channel allowlist (`groups`) + per-user allowlist (`allowFrom`). The skill `/discord:access` is the only place that mutates this; chat messages can carry prompt injection.
- **Management ops** are gated by a single boolean `mgmtEnabled` in `access.json`. They legitimately operate on the *guild* itself — channels that don't yet exist, audit logs, etc. — so the per-channel allowlist is the wrong shape. Trust the bot once, via one flip.
- **No 🔐 permission prompts on management ops.** The bot is trusted on this server; per-call confirmation would just add friction. (The existing `claude/channel/permission` flow stays in place for *Claude Code's own* tool-use approval — a different concern.)

## Bot permissions (Dev Portal → Bot tab)

Required for chat (the original set):
- View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions

Required for Phase 1 management (added 2026-05-08):
- Manage Channels (create / delete / configure)
- Manage Threads (rename / archive / lock / delete threads, view private)
- Manage Messages (bulk-delete, pin)
- View Audit Log

Privileged Gateway Intents in use:
- `MESSAGE_CONTENT` — populates message body for fetched history
- (NOT enabled) `GUILD_MEMBERS` — would be needed for `list_members` / role mgmt (Phase 2, not yet shipped)

## What NOT to do (gotchas)

- **Do not** run `bun --print` against `server.ts` (e.g. to "syntax-check" it). It executes the file, which spins up a real gateway login and can hijack the parent session's MCP poller. Same failure mode as telegram. Use `bun build --no-bundle ./server.ts -o /dev/null` for typechecks.
- **Do not** go back to a marketplace install. The bare-MCP + `--plugin-dir` setup is intentional — see the 2026-05-07 unification memory.
- **Do not** add per-channel permission gates for management ops. The right gate is the single `mgmtEnabled` boolean. A "create_channel only in allowlisted parent" check would be incoherent (the channel doesn't exist yet) and adds no real safety on a single-user server.
- **Do not** add an Administrator-permission shortcut. The user explicitly rejected this; least-privilege is non-negotiable.
- **Do not** modify `~/.claude/clive_channels.json` to point at a different path. The plugin path is load-bearing for `--plugin-dir`.

## How to extend

Adding a new tool:

1. Add a tool definition in the `ListToolsRequestSchema` array (~line 597+).
2. Add a `case` branch in the `CallToolRequestSchema` switch.
3. If the tool is **destructive or structural** (mutates the guild, deletes data, changes shared state), gate it with `assertMgmtEnabled()` at the top of the case body. Surface the gate in the tool description: `"(requires mgmtEnabled in access.json — turn on with /discord:access mgmt on)"`.
4. If the tool needs a new bot permission, document it in this file under "Bot permissions" and tell the user to grant it in the Dev Portal.
5. Update the system-prompt `instructions` block in the MCP server constructor if the tool changes how Claude should think about inbound messages or surfaces a new attribute.

Adding a new inbound event type (e.g. typing, thread create):

1. Make sure the relevant `GatewayIntentBits` flag and `Partials.*` are in the `Client({ intents, partials })` constructor.
2. Register the handler with `client.on('eventName', …)`.
3. Gate via the existing `gate()` for chat-shaped events, or write a thin variant if the gate semantics differ (e.g. reactions skip `requireMention`).
4. Emit `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` — `content` shows up in the agent's view, `meta` becomes XML attributes on the `<channel>` block.
5. Update the system-prompt instructions to tell Claude what the new attribute means.

## Cross-references

- `~/workspace/claude-plugins-official/external_plugins/telegram/server.ts` — the parity reference for any new inbound feature. The two channels are kept structurally similar so the agent's mental model transfers.
- `~/.claude/projects/-home-hli/memory/telegram.md` — the deployment unification memory (applies to discord too).
- `ACCESS.md` (this dir) — user-facing access-control docs.
- `skills/access/SKILL.md` (this dir) — the `/discord:access` skill that mutates `access.json`.
