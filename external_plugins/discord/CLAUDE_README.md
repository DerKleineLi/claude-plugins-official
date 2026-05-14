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
- **2026-05-08** — Reply-rendering pipeline (`format.ts`, new module). Pure helpers; no I/O.
  1. **Smart chunker** (`chunk`). Hierarchy: paragraph (`\n\n`) → line (`\n`) → word (space) → hard cut. Never splits mid-word unless a single word exceeds the limit; never splits mid-line unless a single line does. The legacy `chunkMode` config field (`'length'` | `'newline'`) is deprecated and silently ignored on read.
  2. **Fence preservation across boundaries** (`getOpenFenceAtEnd` + `injectFenceMarkers`, added 2026-05-09). When a chunk boundary falls inside an open fence, a synthetic closer is appended to the chunk before and the matching opener (with the original lang tag and backtick count) is prepended to the chunk after. The per-chunk limit is reduced by `FENCE_RESERVE` (64 chars) so injected markers fit. 4-backtick fences nest 3-backtick fences correctly.

  Side: `MAX_ATTACHMENT_BYTES` was lowered 25 → 10 MB (server.ts) to match Discord's 2024 free-tier cap.

- **2026-05-10** — **Element-attachment pipeline** (replaces the original wrap-table-as-codeblock approach). The user found that Discord's client renders `.txt`/`.md`/`.csv`/`.tex` and most source-code extensions inline with syntax highlighting in its file-preview pane — same UX as a fenced code block, but searchable, copyable, scrollable, and not subject to the 2000-char message limit.

  **Pipeline shape** (`buildReplyMessages` → `parseElements` → renderers):
  1. `parse_elements.ts` walks the reply text in three passes — fenced code blocks first (highest priority, so an inner table or `$$…$$` doesn't escape), then pipe-tables (line-oriented, masked against in-code lines), then display formulas (positional regex, skipping any character range claimed by an earlier pass). Anything between recognized elements is `prose`. Adjacent prose elements are coalesced.
  2. `buildReplyMessages` (now async) emits one `OutboundMessage` per element. Prose runs through the fence-aware chunker (case 1+2 above). Each non-prose element gets its own attachment-only message (`{content: '', files: [...]}`) immediately following its prose context — Discord renders this as a separate timeline entry that the inline-preview / lightbox UI handles.

  **What ships per element:**
  - **Pipe-tables** → `table-N.png` (satori → SVG → resvg-js, dark theme, adaptive column widths) **+** `table-N.md` (column-normalized via `normalizeTableWidths` so the source is also pretty). PNG is the always-visible artifact; `.md` is searchable/copyable.
  - **Display formulas** (`$$…$$`, `\[…\]`, `\begin{equation|equation*|align|align*|aligned|gather|gather*|multline|multline*}…\end{…}`) → `formula-N.png` (mathjax-full → SVG → resvg-js; `currentColor` rewritten to white; dark `#2c2f33` background) **+** `formula-N.tex` (raw source). Inline `$…$` math stays inside prose by design.
  - **Fenced code blocks with a known lang tag** → single `code-N.<ext>` file (`lang_extensions.ts` maps highlight.js v10.6.0 lang IDs + common aliases to canonical extensions). Discord shows it with proper syntax highlighting in the preview pane. The fence markers are stripped — the file holds only the inner source.
  - **Fenced code blocks with empty or unknown lang** → `code-N.txt` (2026-05-11 policy change, replaces the original "stay inline" behavior). Discord renders `.txt` in the file-preview pane with monospace, no syntax highlight, but searchable / scrollable / unbounded by the 2000-char message limit. The right shape for commit lists, log excerpts, untagged code.
  - **`\`\`\`inline` opt-out**: tag a fence with ` ```inline ` (case-insensitive, whitespace-trimmed) to keep it inline as a regular fenced code block in the message body. Useful for short snippets where the inline render reads better than a separate file preview. The parser re-emits the original fence as prose; the chunker's fence-aware logic preserves it across chunk boundaries.

  **Failure modes** (per-element try/catch, never breaks the whole reply):
  - Table PNG render fails → emit `.md` attachment alone (split still happens).
  - Formula PNG render fails → fall back to inline ` ```tex ` code-block of the source. (Bare `.tex` with no visible context would be worse than an inline block.)
  - Code block — no rendering, only extension lookup. Empty/unknown lang routes to `.txt`; ` ```inline ` opts back into inline prose.
  - Buffer > `MAX_ATTACHMENT_BYTES` (10 MB) → fall back to inline. Defensive only; chat-reply elements rarely approach this.

  **Renderers** are pure modules: `render_table.ts` (satori + resvg-js, vendors DejaVu Sans/Sans-Bold/Sans-Mono under `fonts/`), `render_formula.ts` (mathjax-full + resvg-js, MathJax adapter cached at module scope). Both are imported by `format.ts`; the production `buildReplyMessages` calls them directly. Tests inject stub renderers via `buildReplyMessagesWith` to exercise the pipeline deterministically without spinning up satori/mathjax.

  **What was removed:** `wrapPipeTablesAsCodeBlocks`, `splitTableIntoMessages`, `detectOversizedTable`, `TABLE_MULTI_MESSAGE_THRESHOLD` — the multi-message table split, fenced-codeblock wrapping, and oversized-table detection are all subsumed by the file-attach approach (no per-message size limit on the `.md` attachment).

  Tested via `bun test tests/` — `tests/elements.test.ts` covers the parser, `tests/format.test.ts` covers the chunker + buildReplyMessages routing, `tests/render_table.test.ts` (added 2026-05-11) covers `countWrappedLines` and pins a regression test against `tests/fixtures/post_a_plus_g_table.md` (the originally-truncated A+G result table — pre-fix 669 × 172 px with last row clipped, post-A1 669 × 192 px, post-A1.2 669 × 212 px with full last row including the bold post-A+G cell wrapping correctly).

- **2026-05-11** — **Markup-aware `countWrappedLines`** in `render_table.ts` (A1). The wrap simulator now adds the backtick count back into each word's virtual length (each `` ` `` ≈ 4 px of code-span padding via `inlineMd` ≈ 0.5 virtual char at CHAR_PX=7.5) and scales bold runs by 1.10×. Without this, header cells like `` `vis_a` since `a` `` in a 13-char column estimate to 1 line but satori wraps them to 2, and the rendered PNG truncates the last data row. CHAR_PX (7.5) and the bottom `+24 px` slack are unchanged — the simulator-only fix is the strictly-can't-regress shape. CHAR_PX-bump and slack-bump variants were considered and rejected (would widen every table 7% and add 16 px of bottom padding; the simulator-only fix lands the same wins without those side-effects).

- **2026-05-11** — **Single-word overflow** in `countWrappedLines` (A1.2). The original "single-word = 1 line" floor (no break inside a word, so any word longer than the column was reported as 1 line) under-counted satori's actual wrap. Concrete failure: bold `**post-A+G**` in a width-8 column scales to 9 virtual chars (`ceil(8 × 1.10)`), exceeds colWidth, satori wraps to 2 visual lines, but the simulator returned 1 — leaving the row clipped even after A1. Fix: when curLen ends up > colWidth, charge `ceil(curLen / colWidth)` lines total and carry the remainder forward so subsequent words on the same line land on the wrapped tail rather than overlapping it. Strictly additive — never reports fewer lines than the pre-A1.2 formula. Bumped fixture height 192 → 212 px.

- **2026-05-11** — **Render-path word-break + simulator break-word-aware** (A1.3). A1.2 made `countWrappedLines` count overflow tokens as multi-line, but the render path (`cellNode` flex `<div>` with `flexWrap: 'wrap'`) was the unmigrated sibling — satori's flex wrap only breaks at whitespace, so a long unhyphenated token like `verylongunhyphenatedwordthatexceedscolumnwidth` had **zero break opportunities**, rendered on a single visual line, and overflowed horizontally into the neighbouring column (visible collision). Same root cause produced the canvas over-allocation symptom in shaved-column tables: count said N lines, render did 1, leaving (N−1) × 20 px of blank canvas. **Two-part fix:** (a) add `wordBreak: 'break-word'` to the outer cell div — satori's `allowBreakWord` flag then falls back to grapheme-level splits when no UAX #14 opportunity fits, but **prefers whitespace** (unlike `break-all`, which always grapheme-splits and degrades whitespace-wrap quality on cells like `3063 ms (worst 13013)`); (b) update `countWrappedLines` to model break-word's partial-fit behaviour — when a too-long word arrives mid-line, consume the remaining current-line space first, then wrap the residual. Count and render now agree by construction. Reference: satori README's CSS support table; the `linebreak` library (Unicode UAX #14) it delegates to; satori issue #484 (don't rely on inline `<span>` for wrap — relevant because `inlineMd` emits styled spans for code/bold/italic; the fix on the outer cell still works because `word-break` is an inherited property); issue #532 (`overflow: hidden` doesn't actually clip — ruled out as a fallback).

- **2026-05-11** — **Satori auto-height for the canvas** (A1.4). The `countWrappedLines` simulator was an approximation of satori's glyph-width budget — it could only be heuristic, and the heuristic accumulated systematic errors: under-counts on exact-fit cells (absorbed by a +24 px global slack added in A1) and residual over-counts in some shaved-column edge cases. The brief's `list_threads_overflow_table.md` fixture sat at 749×346 because the simulator's prediction was accurate **and** the +24 slack was added on top — leaving 30 px of unused canvas below the last row. **Fix:** pass `height: undefined` to satori, which then auto-computes the layout height from the actual rendered row stack and emits it on the SVG's `height=` attribute. resvg-js picks the height up directly. `countWrappedLines` is retained, exported, and unit-tested as a **diagnostic / count predictor** for future instrumentation, but no longer sizes the SVG canvas. Effect: brief's fixture 346 → 316 px (–30); A1.2 fixture 212 → 210 (–2); overflow_repro 246 → 244 (–2). No clipping, no over-allocation. References: vercel/satori Discussion #614 (dynamic-height pattern); `@altano/satori-fit-text` (community library doing the same).

- **2026-05-11** — `list_threads` read-only forum-post enumeration tool. Wraps discord.js `ForumChannel.threads.fetchActive()` (guild-wide endpoint, filtered to the forum by parent_id in `_mapThreads`) and `fetchArchived({type:'public', before})` (paginated, 100/page, 50-page cap). Server-side `applied_tag_filter` and `include_archived` flags. Not gated on `mgmtEnabled` — pure read, composes with the always-on `get_channel`. Returns a `ThreadSummary[]` shape that's a strict subset of `channelStateJson`. See `Tool reference (read-only, no gate)` below.

- **2026-05-12** — **Color emoji in table PNGs** (`render_table.ts`). Satori's text path uses our DejaVu fonts (no color-emoji glyphs), which had been rendering `✅`/`❌`/`🚀` etc. as tofu (`□`). Fix: register a `loadAdditionalAsset(code='emoji', segment)` callback on the satori call that pulls the per-emoji SVG from jsDelivr's Twemoji mirror (`cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0`, version-pinned for reproducibility) and embeds it as a base64 data URI. Each fetched SVG is cached on disk at `os.tmpdir()/twemoji_cache/<codepoint>.svg` so first render is one network hit per emoji and subsequent renders (including across process restarts) are pure disk reads. `toCodePoint` mirrors Twemoji's filename convention (strip U+FE0F unless it's the only codepoint). Caveat: VS-bearing emojis (`⚠️`, `❤️`) aren't classified as `code='emoji'` by satori's pre-pass and fall through to the monochrome DejaVu glyph — see Known limitations. Reference: vercel/satori README "Emojis"; jdecked/twemoji asset layout.

- **2026-05-12** — **MessageUpdate capture.** New `client.on('messageUpdate', …)` listener + `handleUpdate(msg)` function. When a user edits a previously-sent message, the plugin emits a fresh `notifications/claude/channel` with the new full content (not a diff) and an `edit_of_message_id` attribute on the `<channel>` tag (equal to `message_id` — Discord doesn't renumber on edit, but the attribute's *presence* is the signal that this is an edit-event vs a create-event). `ts` carries the edit time, `original_ts` carries the original send time.

  **Three filters in `handleUpdate`, all needed:**
  1. **Partial resolution** — `if (msg.partial) await msg.fetch()`. Edits on older uncached messages arrive partial (`Partials.Message` was already in the constructor for reactions; reused here). Bail on fetch failure.
  2. **Bot-own + bot-other** — `if (full.author?.id === client.user?.id) return; if (full.author?.bot) return`. Critical: the plugin's own `edit_message` tool path (used for progress updates) fires `messageUpdate` on the gateway with `author.id === client.user.id`. Without this filter every progress edit loops back as a fake user-edit notification.
  3. **Auto-embed / link-unfurl skip** — `if (!full.editedTimestamp) return`. Discord fires `MESSAGE_UPDATE` when it auto-generates an embed for a posted link (image preview, OG card). `edited_timestamp` is **null** in that case and an ISO timestamp on real user edits. This is the cleanest signal — Discord's docs list the field as part of every MESSAGE_UPDATE payload, and discord.js exposes it as `msg.editedTimestamp` (epoch ms) / `msg.editedAt` (Date).

  **Drop-on-`pair`** decision: `gate()` returns `'pair'` for non-allowlisted DM senders, allocating a pairing code. On *edit* this would be incoherent — the original message already had its gate decision, and re-issuing a code on edit would spam the sender. `handleUpdate` treats any non-`'deliver'` gate result as a drop.

  **Re-evaluated gate on edit:** if the user edits a message to *add* `@mention` (or removes one in a `requireMention` channel), gate() naturally reflects the new state. This is intentional — matches what would happen if they'd posted the new content as a fresh message.

  **No content-actually-changed dedupe.** `oldMessage.content` is unreliable in discord.js (often null unless previously cached — long-standing upstream issue), so we forward every edit that passes the bot/auto-embed filters even when content is bit-identical. Genuine edits are infrequent; not worth a fingerprint cache.

  **No new intents / no new bot permissions.** Existing `GuildMessages` + `MessageContent` + `DirectMessages` intents already cover MESSAGE_UPDATE. `Partials.Message` was already there.

  System-prompt instructions block (`server.ts` ~line 532) carries a new paragraph telling the agent that `edit_of_message_id` presence means "this is an edit; body is new full content, not a diff; `original_ts` is original send time, `ts` is edit time; small typo fixes don't need acknowledgement, substantive changes may shift intent."

- **2026-05-14** — **Loosen pipe-table detector in `parse_elements.ts`.** Pass-2 (the table-detection loop) had four restrictions that rejected syntax-valid markdown tables: (1) `minPipes = max(2, headerPipes - 1)` aborted the whole table on any row with even one fewer cell than the header — relaxed to `max(1, headerPipes - 2)` since `render_table.ts:parseTable:109-110` already right-pads short rows; (2) `TABLE_SEP_RE`'s `^\s*` tolerated indentation but not the `>` prefix, so blockquote-wrapped tables fell through — added a per-line `BLOCKQUOTE_PREFIX_RE` (`^\s*>\s?`) strip into a `scanLines` view that's used for the regex check and the `mdSource` body (line offsets stay anchored to the originals); (3) `j > k + 2` required ≥1 data row, dropping header-only tables — loosened to `j > k + 1` (header + separator alone is enough evidence); (4) silent failure on near-misses — added a `console.error('[parse_elements] table near-miss …')` tripwire on the unreachable-after-fix path so any future tightening shows up in logs. Patch is ~25 lines net; uses the project's existing `[module] message` console.error convention. Tested via the existing `bun test tests/elements.test.ts` (27/27 green, no regressions) and a fresh `/tmp/test_table_parse.mjs` covering: short data row, very-short data row, blockquote-wrapped table, single-row table, no-blank-line-before-table, and trailing whitespace on the separator — all 7 emit a `{kind:'table'}` element while a pipe-bearing non-table still emits prose only.

- **2026-05-12** — **MessageDelete capture.** New `client.on('messageDelete', …)` and `client.on('messageDeleteBulk', …)` listeners (the bulk listener fans out per-message into the same `handleDelete`) + `handleDelete(msg, opts?)` function. When a user (or admin) deletes a message in an allowlisted channel, the plugin emits a `notifications/claude/channel` with `deleted='true'` (marker attribute), `ts=<delete-detect time>`, and — when discord.js had the message cached — `user`, `user_id`, `original_ts`, plus the last-known body and any cached `attachment_count` / `reply_to_message_id`. Bulk-arrival deletes carry an extra `bulk_delete='true'` attribute.

  **Why we do not `msg.fetch()` on partials.** Per Discord docs and discord.js's own partials guide, `MESSAGE_DELETE` carries only `{id, channel_id, optional guild_id}` and the message resource is already gone server-side — `fetch()` will throw. Work with whatever discord.js cached (a fresh delete usually has full data because the bot saw the `messageCreate` seconds earlier); on uncached partials, emit with an empty body and omit `user` / `original_ts`.

  **Three filters in `handleDelete`, all needed:**
  1. **`botInitiatedDeletions.has(msg.id)`** — checked FIRST, before any author check. The `bulk_delete_messages` mgmt tool deletes user-authored messages (so `msg.author.id !== client.user.id`), but the bot caused the delete; without this filter every `bulk_delete_messages` call would loop the cleared IDs back as fake user-delete notifications. The set is a small in-memory ring buffer (~200 entries, eviction mirrors `recentSentIds`) populated in `bulk_delete_messages`'s case branch.
  2. **`msg.author?.id === client.user?.id`** — catches a future single-message `delete_message` tool path if/when added.
  3. **`msg.author?.bot`** — skips other bots.

  **Lightweight channel-only gate (does NOT reuse `gate()`).** `gate()` requires `msg.author` for the `requireMention` re-check, and partials usually lack it. A delete is a meta-event about channel state, so the channel-allowlist check is the load-bearing one. Concretely:
  - **DM:** require `msg.author?.id` to be known AND in `access.allowFrom`. Partial DM deletes without author drop silently — we have no allowlist key to check against.
  - **Guild:** look up `chat_id` (resolving thread → parent) in `access.groups`; drop if absent. **`requireMention` is intentionally not checked** — partials usually lack mention data, and a delete of a non-mention message in a `requireMention` channel still surfaces.

  **No audit-log enrichment (deferred).** Discord only writes an audit-log entry when *someone other than the author* deletes a message AND the deleter is not a bot — so self-deletes (the common case) generate no entry. There is also no event-to-log correlation field; matching would require timing heuristics with rate-limit cost on every delete. Easy to add as a Phase 3.5 patch if a moderation use-case ever surfaces.

  **No content-recovery cache.** discord.js's own internal cache populates `msg.content` on fresh-deletes (the bot saw the create event seconds earlier), so a separate ring buffer would mostly duplicate it. Privacy: keeping deleted content past discord.js's natural lifetime extends retention scope beyond "current session memory." If the natural cache hit rate proves too low in practice, revisit in Phase 3.5 with a ~30-LOC ring buffer (200 entries, populated on `messageCreate`, read on `messageDelete`).

  **Bulk handling is fan-out, not aggregate.** `messageDeleteBulk` iterates and calls `handleDelete(msg, { bulk: true })` per message. Reuses the gate + filter logic cleanly; the agent gets per-message context. The `bulk_delete='true'` meta-attribute marks each as part of a batch (often a channel cleanup).

  **No new intents / no new bot permissions.** Same `GuildMessages` + `MessageContent` + `DirectMessages` cover MESSAGE_DELETE / MESSAGE_DELETE_BULK. `Partials.Message` was already there.

  System-prompt instructions block (`server.ts` ~line 536) carries a new paragraph documenting the `deleted='true'` attribute, the cached-vs-empty body, and the `bulk_delete='true'` flag.

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

## Known limitations (deferred)

- **Variation-selector emojis (`⚠️`, `❤️`, etc.) render as monochrome font glyphs in table PNGs.** Post-emoji-fix (2026-05-12, see Local patches below), bare-codepoint emojis like `✅`, `❌`, `🚀` colorize correctly via the Twemoji `loadAdditionalAsset` hook. Emojis bearing U+FE0F (variation-selector-16) — `⚠️ = U+26A0 U+FE0F`, `❤️ = U+2764 U+FE0F`, etc. — satori's grapheme/emoji classifier doesn't tag as `code='emoji'`, so they fall through to the text path and render as the monochrome DejaVu glyph (a 2D warning triangle outline / heart silhouette) instead of colored Twemoji. No tofu — they're still legible — but not colored. Root cause is upstream in satori's `linebreak`/emoji-regex pre-pass; would need a satori patch or a manual pre-walk over reply text. Deferred until VS-bearing emoji become semantically load-bearing in a table.

## Tool reference (mgmt-gated)

`channel/thread/forum CRUD`: `create_channel`, `delete_channel`, `modify_channel`, `create_thread`, `start_forum_post`. **`modify_channel` returns the full updated channel state as JSON** — use this to discover server-assigned IDs after creating new `available_tags`.

`bulk message ops`: `bulk_delete_messages` (≤100, ≤14 days), `pin_message`, `unpin_message`.

`inspection`: `get_channel` (read-only metadata for any channel, including forum `available_tags` with IDs), `get_audit_log` (filter by user/action/before).

## Tool reference (read-only, no gate)

`list_threads` (added 2026-05-11): enumerate forum-post threads in a forum channel. Returns an array of `ThreadSummary {id, name, applied_tags, archived, locked, auto_archive_duration, message_count, member_count, parent_id, rate_limit_per_user}`. Supports `applied_tag_filter` (single tag ID — server-side filter) and `include_archived` (default false; paginates archived public threads via `before` cursor under a 50-page cap). Active threads sorted by id desc (newest creation first), archived in Discord's native archived-time-desc order. Not gated on `mgmtEnabled` — composes with the always-on `get_channel` and the parent's `fetch_messages` path; the parent calls `get_channel` on a specific thread id for additional detail.

Canonical workflow for forum discovery: `list_threads(forum_id)` → pick a thread id → `get_channel(thread_id)` for full state, then `fetch_messages(thread_id)` for content.

The 2-call "create-then-apply" pattern for forum tags:
1. `modify_channel` with `available_tags: [{name: "bug"}]` — response carries the new tag's `id`.
2. `start_forum_post` with `applied_tags: ["<id from step 1>"]`.

Enumerate posts already tagged with a known tag id: `list_threads(forum_id, applied_tag_filter: "<tag_id>")`.

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
