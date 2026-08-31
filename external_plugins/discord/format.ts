// Pure message-formatting helpers for the Discord channel reply path.
// No I/O — kept separate from server.ts so it's unit-testable without
// launching the gateway. Tested in tests/format.test.ts.
//
// Pipeline (see buildReplyMessages below):
//   1. parseElements walks the input text and breaks it into prose,
//      table, formula, and code elements. Detection order in the
//      parser ensures fenced code blocks are claimed first (so an
//      inner table or `$$…$$` doesn't escape).
//   2. Each non-prose element renders to a separate Discord message
//      that carries only file attachments (PNG + source) — Discord's
//      inline preview pane shows them with syntax highlighting for
//      .md / .tex / language-extension files, and the PNG is the
//      always-visible artifact for tables and formulas.
//   3. Prose between elements is split with the existing fence-aware
//      chunker (paragraph > line > word > hard-cut, with synthetic
//      open/close pairs around fences that straddle a boundary).
//
// On per-element render failure: tables fall back to .md-only;
// formulas fall back to an inline ```tex code block; code blocks with
// an unrecognized language tag are kept inline by the parser itself.
//
// MAX_ATTACHMENT_BYTES (10 MB) is a defensive cap matched to
// server.ts's cap; an oversized buffer falls back to inline.

import { AttachmentBuilder } from 'discord.js'
import { parseElements } from './parse_elements'
import { renderMarkdownTableToPng } from './render_table'
import { renderFormulaToPng } from './render_formula'
import { displayWidth, padEndWidth } from './text_width'

export const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/

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
//   - Widths are display columns, not UTF-16 code units: East-Asian
//     Wide/Fullwidth codepoints count as 2 (see text_width.ts). Padding
//     with `.length` used to misalign a CJK table by one cell per
//     ideograph in a monospace viewer. Emoji-presentation symbols
//     (`✅`, `❌`, …) are Wide under Unicode 9+ and count 2 as well.
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
      const len = displayWidth(rows[r][c])
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
    const padded = cells.map((cell, c) => padEndWidth(cell, colWidths[c]))
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
//
// When the input contains fenced code blocks (```...```), splits that
// would otherwise leave a fence open across the boundary are made
// safe: a synthetic closing fence is appended to the chunk before the
// boundary, and a matching opening fence (with the original lang tag
// and backtick count) is prepended to the chunk after. Each emitted
// chunk is then valid Discord markdown on its own. The per-chunk
// limit is reduced by FENCE_RESERVE in this case so the injected
// markers fit within `limit`.
export function chunk(text: string, limit: number = MAX_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]
  if (!text.includes('```')) return chunkRaw(text, limit)
  const innerLimit = Math.max(MIN_INNER_LIMIT, limit - FENCE_RESERVE)
  return injectFenceMarkers(chunkRaw(text, innerLimit))
}

// Worst-case overhead per chunk for fence injection: an opener at the
// start (≤4 backticks + clamped lang up to MAX_LANG_LEN + newline)
// plus a closer at the end (newline + ≤4 backticks). 64 leaves a
// comfortable cushion above that.
const FENCE_RESERVE = 64
const MIN_INNER_LIMIT = 64
const MAX_LANG_LEN = 50

// The original line/word/paragraph-aware splitter, no awareness of code
// fences. chunk() wraps this with fence-injection logic when fences
// are present in the input.
function chunkRaw(text: string, limit: number): string[] {
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

// Returns the open-fence state at the end of `text`, or null if every
// fence in `text` is balanced. Used by the chunker to decide whether
// a chunk boundary needs a synthetic closer/opener.
//
// Detection rules (CommonMark-flavored, simplified for Discord):
//   - A fence line is a line whose first non-whitespace run is ≥3
//     backticks, optionally followed by an "info string" (typically
//     a language tag like `python` or `ts`).
//   - When outside a fence, the first such line opens one. The lang
//     is the trimmed remainder (clamped to MAX_LANG_LEN to keep
//     re-emitted openers within the per-chunk fence budget).
//   - When inside a fence, a line closes it ONLY if its backtick run
//     is ≥ the opener's count AND there is no extra non-whitespace
//     content on the line. Inline backticks (e.g. `let x = 1`) on
//     content lines are ignored — they don't satisfy the leading-≥3
//     rule.
//   - 4-backtick fences nest 3-backtick fences (a 3-tick line inside
//     a 4-tick block is content, not a closer).
export function getOpenFenceAtEnd(
  text: string,
): { lang: string; fenceLen: number } | null {
  let state: { lang: string; fenceLen: number } | null = null
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(`{3,})\s*(\S.*)?$/)
    if (!m) continue
    const len = m[1].length
    const rest = (m[2] ?? '').trim()
    if (state === null) {
      state = { lang: rest.slice(0, MAX_LANG_LEN), fenceLen: len }
    } else if (len >= state.fenceLen && rest === '') {
      state = null
    }
  }
  return state
}

// Walk a list of raw chunks and, at every boundary that falls inside
// an open fence, append a closer to the chunk before and prepend a
// matching opener to the chunk after. Each output chunk is then
// independently fence-balanced.
function injectFenceMarkers(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  const out: string[] = []
  let openFromPrev: { lang: string; fenceLen: number } | null = null
  for (let i = 0; i < chunks.length; i++) {
    let body = chunks[i]
    if (openFromPrev !== null) {
      const opener = '`'.repeat(openFromPrev.fenceLen) + openFromPrev.lang
      body = opener + '\n' + body
    }
    // Recompute on the augmented body so a re-opened fence is counted.
    const stateNow = getOpenFenceAtEnd(body)
    const isLast = i === chunks.length - 1
    if (stateNow !== null && !isLast) {
      body = body + '\n' + '`'.repeat(stateNow.fenceLen)
    }
    out.push(body)
    openFromPrev = !isLast ? stateNow : null
  }
  return out
}

export type OutboundMessage = { content: string; files?: AttachmentBuilder[] }

// Wrap a render call so a thrown error is logged once and surfaces as
// null to the caller — keeps a per-element render failure from breaking
// the whole reply.
async function tryRender(fn: () => Promise<Buffer | null>): Promise<Buffer | null> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[discord/format] render failed: ${msg}\n`)
    return null
  }
}

function attachmentFromBuffer(buf: Buffer, name: string): AttachmentBuilder | null {
  if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return null
  return new AttachmentBuilder(buf, { name })
}

// Internal: same as buildReplyMessages but accepts injected renderers,
// so tests can stub PNG render to throw without monkey-patching modules.
export async function buildReplyMessagesWith(
  text: string,
  chunkLimit: number,
  renderTable: (md: string) => Promise<Buffer | null>,
  renderFormula: (tex: string) => Promise<Buffer>,
): Promise<OutboundMessage[]> {
  const elements = parseElements(text)
  const out: OutboundMessage[] = []
  let tableIdx = 0
  let formulaIdx = 0
  let codeIdx = 0

  const pushProse = (raw: string) => {
    const trimmed = raw.replace(/^\s+|\s+$/g, '')
    if (!trimmed) return
    for (const c of chunk(trimmed, chunkLimit)) out.push({ content: c })
  }

  for (const el of elements) {
    if (el.kind === 'prose') {
      pushProse(el.text)
      continue
    }
    if (el.kind === 'table') {
      tableIdx++
      const png = await tryRender(() => renderTable(el.mdSource))
      const files: AttachmentBuilder[] = []
      if (png) {
        const a = attachmentFromBuffer(png, `table-${tableIdx}.png`)
        if (a) files.push(a)
      }
      const mdBuf = Buffer.from(normalizeTableWidths(el.mdSource), 'utf8')
      const mdAtt = attachmentFromBuffer(mdBuf, `table-${tableIdx}.md`)
      if (mdAtt) files.push(mdAtt)
      if (files.length > 0) out.push({ content: '', files })
      continue
    }
    if (el.kind === 'formula') {
      formulaIdx++
      const png = await tryRender(() => renderFormula(el.texSource))
      if (png) {
        const pngAtt = attachmentFromBuffer(png, `formula-${formulaIdx}.png`)
        const texAtt = attachmentFromBuffer(
          Buffer.from(el.texSource, 'utf8'),
          `formula-${formulaIdx}.tex`,
        )
        const files: AttachmentBuilder[] = []
        if (pngAtt) files.push(pngAtt)
        if (texAtt) files.push(texAtt)
        if (files.length > 0) {
          out.push({ content: '', files })
          continue
        }
      }
      // Fallback: inline ```tex code-block of the source. Better than a
      // bare .tex with no visible context.
      pushProse('```tex\n' + el.texSource + '\n```')
      continue
    }
    // el.kind === 'code'
    codeIdx++
    const buf = Buffer.from(el.source, 'utf8')
    const att = attachmentFromBuffer(buf, `code-${codeIdx}.${el.ext}`)
    if (att) {
      out.push({ content: '', files: [att] })
    } else {
      // Defensive: oversized code block falls back to inline. Keeps
      // the bot useful instead of dropping the content entirely.
      pushProse('```' + el.lang + '\n' + el.source + '\n```')
    }
  }
  return out
}

// Top-level: route input text into the element-attachment pipeline.
// Each table/formula/code element becomes its own attachment-only
// message; prose runs through the fence-aware chunker.
export async function buildReplyMessages(
  text: string,
  chunkLimit: number = MAX_CHUNK_LIMIT,
): Promise<OutboundMessage[]> {
  return buildReplyMessagesWith(
    text,
    chunkLimit,
    renderMarkdownTableToPng,
    renderFormulaToPng,
  )
}
