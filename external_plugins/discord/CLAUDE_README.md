# CLAUDE_README — Discord channel plugin

Project memory for future-you (Claude). User-facing docs are in `README.md` and `ACCESS.md`. **Read this before editing.**

## What this is

The user's Discord channel plugin — an MCP server (`server.ts`, the wired entry point, ~1k LOC; `format.ts` for pure message-formatting helpers, ~200 LOC; tests under `tests/`) that bridges Discord to a Claude Code session. Originally forked from [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official); the active branch is `local/main` of `DerKleineLi/claude-plugins-official` (the user's fork). Local edits live on top of upstream.

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
- **2026-05-08** — Channel inspection: `get_channel` (read-only) returns full metadata as JSON, including forum `available_tags` with their server-assigned IDs. `modify_channel` now also returns the full updated state in its response, so creating a tag and applying it to a post is a 2-call sequence (modify → start_forum_post with `applied_tags`) instead of 3 (modify → get → start_forum_post).
- **2026-05-08** — Reply-rendering pipeline (`format.ts`, new module). Four user-visible changes, applied to every outbound `reply` call:
  1. **Smart chunker.** Hierarchy: paragraph (`\n\n`) → line (`\n`) → word (space) → hard cut. Never splits mid-word unless a single word exceeds the limit; never splits mid-line unless a single line does. The legacy `chunkMode` config field (`'length'` | `'newline'`) is deprecated and silently ignored on read; one mode now.
  2. **Pipe-table → fenced code block.** Discord's client does not render `|`-table markdown ([open feature request](https://support.discord.com/hc/en-us/community/posts/16131946321815)) — `wrapPipeTablesAsCodeBlocks` detects header + `:?-+:?` separator + ≥1 data rows and wraps the block in plain ` ``` `. Pre-existing fenced code blocks are protected from double-wrapping. Pipe-count check on data rows prevents the table from extending into prose that contains a stray `|`. Tables are column-width-normalized via `normalizeTableWidths` before fencing — every cell is `padEnd`'d to its column's max width (min 3) so the monospace render shows aligned columns. Alignment-marker colons in the separator row are preserved positionally; data rows are uniformly left-aligned regardless of `:---` / `---:` markers (the colon is a hint, not enforced in monospace).
     - **Wide-char caveat:** `.length` counts UTF-16 code units, not display columns. CJK characters and most emoji occupy two display cells but `.length` 1, so a row with wide chars will visually misalign by one cell per occurrence. We accept this rather than pulling in a wide-char display-width library; the alignment is correct for ASCII and degrades gracefully for everything else.
  3. **Multi-message table split.** When a wrapped table would exceed 1900 chars, `splitTableIntoMessages` packs rows greedily across multiple sends, each one a stand-alone fenced block beginning with the original header + separator. Continuation messages (k > 1) are prefixed with `_continued (k/N)_` on a line above the fence. Column widths are computed once over the **full** table (not per-chunk) so every chunk shares the same widths and consecutive messages line up.
  4. **`.md` attachment fallback.** When a single row alone exceeds the per-message row budget, the (normalized) table is sent as a `table.md` buffer attachment with a one-line summary in `content`. Pre/post prose around the table is still sent inline.

  Side: `MAX_ATTACHMENT_BYTES` was lowered 25 → 10 MB to match Discord's 2024 free-tier cap (the old value would let oversize files through `assertSendable` only to be rejected by Discord's API).

  Pure helpers live in `format.ts` (no I/O); unit-tested via `bun test tests/format.test.ts`.

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

## Tool reference (mgmt-gated)

`channel/thread/forum CRUD`: `create_channel`, `delete_channel`, `modify_channel`, `create_thread`, `start_forum_post`. **`modify_channel` returns the full updated channel state as JSON** — use this to discover server-assigned IDs after creating new `available_tags`.

`bulk message ops`: `bulk_delete_messages` (≤100, ≤14 days), `pin_message`, `unpin_message`.

`inspection`: `get_channel` (read-only metadata for any channel, including forum `available_tags` with IDs), `get_audit_log` (filter by user/action/before).

The 2-call "create-then-apply" pattern for forum tags:
1. `modify_channel` with `available_tags: [{name: "bug"}]` — response carries the new tag's `id`.
2. `start_forum_post` with `applied_tags: ["<id from step 1>"]`.

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
