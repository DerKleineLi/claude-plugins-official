// Pure message-formatting helpers for the Discord channel reply path.
// No I/O — kept separate from server.ts so it's unit-testable without
// launching the gateway. Tested in tests/format.test.ts.
//
// Pipeline (caller side, see buildReplyMessages below):
//   1. detectOversizedTable — find first table whose wrapped size
//      exceeds the multi-message threshold. If found, the caller hands
//      it to splitTableIntoMessages, which emits one fenced code-block
//      per message (each with the original header + separator) and
//      falls back to a .md attachment if a single row alone exceeds
//      the per-message budget.
//   2. Otherwise, wrapPipeTablesAsCodeBlocks fence-wraps any pipe
//      tables in place — Discord's client doesn't render `|` markdown,
//      but a fenced block is monospace and preserves column alignment.
//   3. chunk splits the (possibly wrapped) text on the safest available
//      boundary: paragraph > line > word > hard-cut.

import { AttachmentBuilder } from 'discord.js'

export const MAX_CHUNK_LIMIT = 2000
export const TABLE_MULTI_MESSAGE_THRESHOLD = 1900

const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
const PROTECT_RE = /__DISCORD_CB_(\d+)__/g

function protectCodeBlocks(text: string): { protected: string; blocks: string[] } {
  const blocks: string[] = []
  const protectedText = text.replace(/```[\s\S]*?```/g, m => {
    blocks.push(m)
    return `__DISCORD_CB_${blocks.length - 1}__`
  })
  return { protected: protectedText, blocks }
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  return text.replace(PROTECT_RE, (_, n) => blocks[Number(n)])
}

// Parse a single table row line into trimmed cells. Strips one leading
// and one trailing empty cell if the line had surrounding `|` (the
// `| a | b |` style). Internal empty cells (`| a || c |`) are kept,
// since they're meaningful gaps in the table.
function parseTableRow(line: string): string[] {
  const parts = line.split('|').map(s => s.trim())
  if (parts.length > 1 && parts[0] === '') parts.shift()
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// Re-emit a parsed table with each cell padded to its column's max width
// (using `.padEnd`, i.e. content-left, padding-right). Inside a fenced
// code block this gives Discord-friendly column alignment, since the
// pipe-syntax table renderer doesn't exist for bot messages.
//
// Notes:
//   - Width is taken over header + data rows; the separator's dashes are
//     re-generated to fit the column width (min 3 dashes).
//   - Alignment markers (`:` at cell start/end of the separator) are
//     preserved in their original position; data rows are still
//     left-padded (we don't honor `---:` right-alignment in monospace —
//     the colon is a hint to readers, not enforced).
//   - `.length` counts UTF-16 code units, not display columns. CJK and
//     emoji that occupy 2 display cells will visually misalign by one
//     cell per occurrence. Documented as a known caveat in CLAUDE_README.
//   - Mismatched column counts: the row with the most columns sets the
//     count; shorter rows are padded with empty trailing cells.
export function normalizeTableWidths(tableBlock: string): string {
  const lines = tableBlock.split('\n')
  if (lines.length < 2) return tableBlock

  const rows: string[][] = lines.map(parseTableRow)
  const numCols = Math.max(...rows.map(r => r.length))
  if (numCols === 0) return tableBlock

  for (const row of rows) {
    while (row.length < numCols) row.push('')
  }

  const colWidths: number[] = new Array(numCols).fill(0)
  for (let r = 0; r < rows.length; r++) {
    if (r === 1) continue // separator handled separately
    for (let c = 0; c < numCols; c++) {
      const len = rows[r][c].length
      if (len > colWidths[c]) colWidths[c] = len
    }
  }
  // Min 3 so the separator's `---` always renders as a separator.
  for (let c = 0; c < numCols; c++) {
    colWidths[c] = Math.max(3, colWidths[c])
  }

  const sepCells = rows[1].map((src, c) => {
    const width = colWidths[c]
    const leftAlign = src.startsWith(':')
    const rightAlign = src.length > 1 && src.endsWith(':')
    const dashCount = Math.max(1, width - (leftAlign ? 1 : 0) - (rightAlign ? 1 : 0))
    return (leftAlign ? ':' : '') + '-'.repeat(dashCount) + (rightAlign ? ':' : '')
  })

  const out: string[] = []
  for (let r = 0; r < rows.length; r++) {
    const cells = r === 1 ? sepCells : rows[r]
    const padded = cells.map((cell, c) => cell.padEnd(colWidths[c]))
    out.push('| ' + padded.join(' | ') + ' |')
  }
  return out.join('\n')
}

// Find contiguous markdown-table blocks: header line containing `|`,
// followed by a separator line (`:?-+:?` cells), followed by ≥1 data
// rows whose pipe count matches the header (within ±1, to allow tables
// that omit the leading/trailing pipe). Returns line-index ranges
// [start, end) into `lines`.
//
// The pipe-count check matters: a permissive `includes('|')` rule
// would happily extend a table into a prose paragraph that mentions
// `|` once.
export function findTablesInLines(lines: string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let i = 0
  while (i < lines.length - 1) {
    if (lines[i].includes('|') && TABLE_SEP_RE.test(lines[i + 1])) {
      const headerPipes = (lines[i].match(/\|/g) || []).length
      const minPipes = Math.max(2, headerPipes - 1)
      let j = i + 2
      while (j < lines.length && lines[j].trim() !== '') {
        const rowPipes = (lines[j].match(/\|/g) || []).length
        if (rowPipes < minPipes) break
        j++
      }
      if (j > i + 2) {
        out.push({ start: i, end: j })
        i = j
        continue
      }
    }
    i++
  }
  return out
}

// Wrap every pipe-table in `text` in plain ```...``` fences. Each table
// is column-width-normalized first (so monospace rendering inside the
// fence shows aligned columns). Pre-existing fenced code blocks are
// protected from double-wrapping (a stray `|` in a code block won't
// trigger detection).
export function wrapPipeTablesAsCodeBlocks(text: string): string {
  const { protected: prot, blocks } = protectCodeBlocks(text)
  const lines = prot.split('\n')
  const tables = findTablesInLines(lines)
  if (tables.length === 0) return text

  // Walk back-to-front so earlier (start, end) ranges stay valid.
  for (let k = tables.length - 1; k >= 0; k--) {
    const { start, end } = tables[k]
    const tableBlock = lines.slice(start, end).join('\n')
    const normalized = normalizeTableWidths(tableBlock).split('\n')
    lines.splice(start, end - start, '```', ...normalized, '```')
  }
  return restoreCodeBlocks(lines.join('\n'), blocks)
}

// Find the FIRST table in `text` whose wrapped size exceeds `threshold`.
// Returns the raw (unwrapped) table block plus the prose around it,
// or null. Wraps the search in code-block protection so a `|` row
// inside a pre-existing fence doesn't masquerade as a table.
export function detectOversizedTable(
  text: string,
  threshold: number,
): { pre: string; table: string; post: string } | null {
  const { protected: prot, blocks } = protectCodeBlocks(text)
  const lines = prot.split('\n')
  const tables = findTablesInLines(lines)

  for (const { start, end } of tables) {
    const tableLines = lines.slice(start, end)
    const tableBlock = tableLines.join('\n')
    // Fence overhead is ```\n at start (4) + \n``` at end (4) = 8.
    if (tableBlock.length + 8 > threshold) {
      const pre = restoreCodeBlocks(lines.slice(0, start).join('\n'), blocks)
      const post = restoreCodeBlocks(lines.slice(end).join('\n'), blocks)
      return { pre, table: tableBlock, post }
    }
  }
  return null
}

// Line-/word-aware splitter. Hierarchy of preferred split points (latest
// within-window wins among feasible):
//   1. paragraph boundary (\n\n) within [limit/4, limit]
//   2. line boundary (\n) within [0, limit]
//   3. word boundary (space) within [0, limit]
//   4. hard cut at `limit` (only if a single token > limit)
//
// Trailing whitespace is trimmed per chunk. Splitting NEVER happens
// mid-line unless a single line is itself > limit, and NEVER mid-word
// unless a single word is > limit.
export function chunk(text: string, limit: number = MAX_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut: number
    const para = window.lastIndexOf('\n\n')
    if (para >= Math.floor(limit / 4)) {
      cut = para + 2
    } else {
      const line = window.lastIndexOf('\n')
      if (line >= 0) {
        cut = line + 1
      } else {
        const space = window.lastIndexOf(' ')
        if (space >= 0) {
          cut = space + 1
        } else {
          cut = limit
        }
      }
    }
    out.push(rest.slice(0, cut).replace(/\s+$/, ''))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

export type OutboundMessage = { content: string; files?: AttachmentBuilder[] }

// Render an oversized table across multiple messages. Each message is a
// stand-alone fenced code block beginning with the original header +
// separator (so it reads as a valid table on its own). Continuation
// messages (k > 1 of N) are prefixed with `_continued (k/N)_` on a line
// above the fence.
//
// If a single row's length exceeds the per-message budget, falls back
// to attaching the raw markdown as `table.md` with a one-line summary.
// Pre/post prose, if any, is chunked separately and ordered around the
// table messages.
export function splitTableIntoMessages(
  pre: string,
  tableBlock: string,
  post: string,
  tableThreshold: number,
  chunkLimit: number,
): OutboundMessage[] {
  // Normalize widths over the FULL table once, so every emitted chunk
  // shares the same column widths (rather than each chunk re-deriving
  // widths from its own row subset, which would give jagged alignment
  // between consecutive messages).
  const normalized = normalizeTableWidths(tableBlock)
  const lines = normalized.split('\n')
  if (lines.length < 3) {
    return chunk([pre, normalized, post].filter(Boolean).join('\n').trim(), chunkLimit).map(
      c => ({ content: c }),
    )
  }
  const header = lines[0]
  const separator = lines[1]
  const rows = lines.slice(2)

  // Per-chunk body shape:
  //   [marker]```\nheader\nseparator\nrow0\n...\nrowM-1\n```
  // Length = marker + 9 + header + separator + sum(rowLens) + numRows
  // Reserve 25 chars for the worst-case continuation marker (the actual
  // marker `_continued (kk/NN)_\n` is 22; pad to 25).
  const markerReserve = 25
  const fixedNonRowOverhead = header.length + separator.length + 9
  const rowsBudget = tableThreshold - markerReserve - fixedNonRowOverhead

  const longestRow = rows.length > 0 ? Math.max(...rows.map(r => r.length)) : 0
  if (longestRow + 1 > rowsBudget) {
    // Single-row overflow → attachment fallback for the table itself.
    // Pre/post prose still gets sent inline. We attach the normalized
    // version (already aligned) since that's what we've been working
    // with — same content, nicer-looking in Discord's .md preview.
    const buf = Buffer.from(normalized, 'utf-8')
    const attachment = new AttachmentBuilder(buf, { name: 'table.md' })
    const preMsgs = pre.trim()
      ? chunk(pre.trim(), chunkLimit).map(c => ({ content: c }))
      : []
    const postMsgs = post.trim()
      ? chunk(post.trim(), chunkLimit).map(c => ({ content: c }))
      : []
    return [
      ...preMsgs,
      {
        content: 'Table too large to render inline (single row exceeds the limit). See attachment.',
        files: [attachment],
      },
      ...postMsgs,
    ]
  }

  // Greedy pack rows into per-chunk groups within rowsBudget.
  const rowChunks: string[][] = []
  let current: string[] = []
  let currentSize = 0
  for (const row of rows) {
    const cost = row.length + 1
    if (currentSize + cost > rowsBudget && current.length > 0) {
      rowChunks.push(current)
      current = []
      currentSize = 0
    }
    current.push(row)
    currentSize += cost
  }
  if (current.length > 0) rowChunks.push(current)

  const N = rowChunks.length
  const tableMessages: OutboundMessage[] = rowChunks.map((rs, k) => {
    const marker = k > 0 ? `_continued (${k + 1}/${N})_\n` : ''
    const body = `${marker}\`\`\`\n${header}\n${separator}\n${rs.join('\n')}\n\`\`\``
    return { content: body }
  })

  const preMsgs = pre.trim()
    ? chunk(pre.trim(), chunkLimit).map(c => ({ content: c }))
    : []
  const postMsgs = post.trim()
    ? chunk(post.trim(), chunkLimit).map(c => ({ content: c }))
    : []
  return [...preMsgs, ...tableMessages, ...postMsgs]
}

// Top-level convenience: route input text into the appropriate render
// pipeline. Returns an array of {content, files?} ready for ch.send.
export function buildReplyMessages(text: string, chunkLimit: number): OutboundMessage[] {
  const oversize = detectOversizedTable(text, TABLE_MULTI_MESSAGE_THRESHOLD)
  if (oversize) {
    return splitTableIntoMessages(
      oversize.pre,
      oversize.table,
      oversize.post,
      TABLE_MULTI_MESSAGE_THRESHOLD,
      chunkLimit,
    )
  }
  const formatted = wrapPipeTablesAsCodeBlocks(text)
  return chunk(formatted, chunkLimit).map(c => ({ content: c }))
}
