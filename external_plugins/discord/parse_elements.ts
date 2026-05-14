// Walk an outbound reply text once and break it into a flat sequence of
// "elements": prose, table, formula, code. The element-attachment
// pipeline in format.ts → buildReplyMessages renders each non-prose
// element to a separate Discord message carrying only file attachments
// (PNG + source), with prose chunks emitted in original order around
// them.
//
// Detection order matters and is implemented as three passes over the
// same text, with later passes skipping any character range claimed by
// an earlier pass:
//
//   1. Fenced code blocks (line-oriented). Done first so a pipe-table
//      or `$$…$$` *inside* a fenced block stays as code, not a table /
//      formula. A code block whose lang tag isn't in lang_extensions.ts
//      is emitted back as prose (preserving the original fence) — the
//      caller's chunker handles it as a normal fenced block.
//   2. Pipe-tables. Reused detection logic from format.ts:
//      findTablesInLines, masked against in-code lines.
//   3. Display formulas (positional regex). Pulled out: `$$…$$`,
//      `\[…\]`, and the common `\begin{equation|align|aligned|gather|
//      multline}…\end{…}` envs (with their starred variants). Inline
//      `$…$` and inline backtick spans stay inside prose by design.
//
// All three passes produce char-offset ranges into the original text.
// The ranges are sorted and the gaps between them become prose
// elements. Adjacent prose elements are coalesced (which can happen
// when an unknown-lang code block is re-emitted as prose between two
// other prose pieces).

import { langToExt } from './lang_extensions'

export type Element =
  | { kind: 'prose'; text: string }
  | { kind: 'table'; mdSource: string }
  | { kind: 'formula'; texSource: string; delimiter: 'dollar' | 'bracket' | 'env' }
  | { kind: 'code'; lang: string; ext: string; source: string }

const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/
// Strip a single leading blockquote marker so tables inside `>` quotes
// are still detected. We only normalize for detection — `mdSource` is
// rebuilt from stripped lines so `render_table.ts:parseTable` sees clean
// pipes (it tolerates either form anyway).
const BLOCKQUOTE_PREFIX_RE = /^\s*>\s?/
const FENCE_OPEN_RE = /^\s*(`{3,})\s*(\S.*)?$/
const FENCE_CLOSE_RE = /^\s*(`{3,})\s*$/

// Recognized display-formula envs. Starred variants are unnumbered
// versions; same shape, different name.
const FORMULA_ENV_NAMES = [
  'equation', 'equation\\*',
  'align', 'align\\*',
  'aligned',
  'gather', 'gather\\*',
  'multline', 'multline\\*',
].join('|')

const FORMULA_PATTERNS: Array<{ re: RegExp; delim: 'dollar' | 'bracket' | 'env' }> = [
  { re: /\$\$([\s\S]+?)\$\$/g, delim: 'dollar' },
  { re: /\\\[([\s\S]+?)\\\]/g, delim: 'bracket' },
  { re: new RegExp(`\\\\begin\\{(${FORMULA_ENV_NAMES})\\}([\\s\\S]+?)\\\\end\\{\\1\\}`, 'g'), delim: 'env' },
]

interface RawRange {
  start: number
  end: number
  kind: 'code' | 'table' | 'formula'
  payload:
    | { lang: string; source: string }
    | { mdSource: string }
    | { texSource: string; delimiter: 'dollar' | 'bracket' | 'env' }
  rawSlice: string
}

function computeLineOffsets(lines: string[]): number[] {
  const offsets: number[] = new Array(lines.length)
  let cursor = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = cursor
    cursor += lines[i].length + 1 // +1 for the consumed '\n'
  }
  return offsets
}

function rangesOverlap(a: { start: number; end: number }, bs: RawRange[]): boolean {
  for (const b of bs) if (!(a.end <= b.start || a.start >= b.end)) return true
  return false
}

export function parseElements(text: string): Element[] {
  const ranges: RawRange[] = []
  const lines = text.split('\n')
  const lineOffsets = computeLineOffsets(lines)

  // --- pass 1: fenced code blocks ---
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(FENCE_OPEN_RE)
    if (!m) { i++; continue }
    const fenceLen = m[1].length
    const lang = (m[2] ?? '').trim()
    let j = i + 1
    let closed = false
    while (j < lines.length) {
      const m2 = lines[j].match(FENCE_CLOSE_RE)
      if (m2 && m2[1].length >= fenceLen) { closed = true; break }
      j++
    }
    if (!closed) { i++; continue }
    const start = lineOffsets[i]
    // End includes the closing fence line. Offset of line j + length of line j.
    const end = lineOffsets[j] + lines[j].length
    const source = lines.slice(i + 1, j).join('\n')
    ranges.push({
      start, end, kind: 'code',
      payload: { lang, source },
      rawSlice: text.slice(start, end),
    })
    i = j + 1
  }

  // --- pass 2: pipe-tables (skip lines inside code-block ranges) ---
  const inCode = new Array(lines.length).fill(false)
  for (let k = 0; k < lines.length; k++) {
    const lineStart = lineOffsets[k]
    for (const r of ranges) {
      if (r.kind === 'code' && lineStart >= r.start && lineStart < r.end) {
        inCode[k] = true
        break
      }
    }
  }
  // Pre-strip a single blockquote prefix per line for detection. The
  // unstripped originals are retained for offset bookkeeping, but the
  // table source we ship downstream is rebuilt from the stripped lines
  // so `render_table.ts:parseTable` doesn't see stray `>` glyphs in the
  // first cell.
  const scanLines = lines.map(l => l.replace(BLOCKQUOTE_PREFIX_RE, ''))
  let k = 0
  while (k < lines.length - 1) {
    if (inCode[k] || inCode[k + 1]) { k++; continue }
    if (!scanLines[k].includes('|') || !TABLE_SEP_RE.test(scanLines[k + 1])) { k++; continue }
    const headerPipes = (scanLines[k].match(/\|/g) || []).length
    // Trust render_table.ts:parseTable's existing right-pad logic
    // (lines 109-110: `while (r.length < w) r.push('')`) to fill short
    // rows. Just require enough pipes for at least one cell boundary.
    const minPipes = Math.max(1, headerPipes - 2)
    let j = k + 2
    while (j < lines.length && scanLines[j].trim() !== '' && !inCode[j]) {
      const rowPipes = (scanLines[j].match(/\|/g) || []).length
      if (rowPipes < minPipes) break
      j++
    }
    // Allow single-row tables (header + separator, no data rows). The
    // separator line alone is enough evidence this is a table — emit it
    // and let render_table handle the empty-rows case.
    if (j > k + 1) {
      const start = lineOffsets[k]
      const end = lineOffsets[j - 1] + lines[j - 1].length
      const mdSource = scanLines.slice(k, j).join('\n')
      ranges.push({
        start, end, kind: 'table',
        payload: { mdSource },
        rawSlice: text.slice(start, end),
      })
      k = j
      continue
    }
    // Near-miss diagnostic: header + separator matched but the data-row
    // loop bailed before producing any rows AND we're not emitting as a
    // single-row table. With `j > k + 1` above this branch is currently
    // unreachable, but logged here as a tripwire for future regressions
    // that tighten the emit condition.
    console.error(`[parse_elements] table near-miss at line ${k}: header+separator matched but no emit (j=${j}, k+1=${k + 1})`)
    k++
  }

  // --- pass 3: display formulas (positional regex, skip existing ranges) ---
  for (const { re, delim } of FORMULA_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (rangesOverlap({ start, end }, ranges)) continue
      const texSource = (delim === 'env' ? m[2] : m[1]).trim()
      if (texSource === '') continue
      ranges.push({
        start, end, kind: 'formula',
        payload: { texSource, delimiter: delim },
        rawSlice: text.slice(start, end),
      })
    }
  }

  // --- assemble: sort + emit gaps as prose ---
  ranges.sort((a, b) => a.start - b.start)
  const out: Element[] = []
  let cursor = 0
  for (const r of ranges) {
    if (cursor < r.start) {
      out.push({ kind: 'prose', text: text.slice(cursor, r.start) })
    }
    if (r.kind === 'code') {
      const p = r.payload as { lang: string; source: string }
      const ext = langToExt(p.lang)
      const langKey = p.lang.trim().toLowerCase()
      if (ext) {
        out.push({ kind: 'code', lang: p.lang, ext, source: p.source })
      } else if (langKey === 'inline') {
        // Author-opted-in inline rendering via the magic `\`\`\`inline`
        // tag — keep the original fenced block as prose so Discord
        // renders it as an inline code block. The chunker's fence-aware
        // logic will preserve it across chunk boundaries.
        out.push({ kind: 'prose', text: r.rawSlice })
      } else {
        // Empty lang OR unknown lang → ship as `code-N.txt`. Discord's
        // file-preview pane renders .txt inline with monospace, no
        // syntax highlight, but searchable / scrollable / unbounded by
        // the 2000-char message limit. Use `\`\`\`inline` to opt out.
        out.push({ kind: 'code', lang: p.lang, ext: 'txt', source: p.source })
      }
    } else if (r.kind === 'table') {
      const p = r.payload as { mdSource: string }
      out.push({ kind: 'table', mdSource: p.mdSource })
    } else if (r.kind === 'formula') {
      const p = r.payload as { texSource: string; delimiter: 'dollar' | 'bracket' | 'env' }
      out.push({ kind: 'formula', texSource: p.texSource, delimiter: p.delimiter })
    }
    cursor = r.end
  }
  if (cursor < text.length) {
    out.push({ kind: 'prose', text: text.slice(cursor) })
  }

  // Coalesce adjacent prose elements (unknown-lang code blocks re-emitted
  // as prose can sandwich between two real prose chunks).
  const coalesced: Element[] = []
  for (const el of out) {
    const last = coalesced[coalesced.length - 1]
    if (el.kind === 'prose' && last?.kind === 'prose') {
      last.text += el.text
    } else {
      coalesced.push(el)
    }
  }
  // Drop empty prose entries.
  return coalesced.filter(el => el.kind !== 'prose' || el.text.length > 0)
}
