// Render a markdown pipe-table to PNG via satori (vdom → SVG) + resvg-js
// (SVG → PNG). Wired into format.ts → buildReplyMessages so every table
// in an outbound reply ships as a PNG attachment immediately after the
// fenced-codeblock chunk that closed it.
//
// We build the satori-friendly vdom directly (skipping satori-html, which
// chokes on multi-style nested HTML). The vdom shape Satori accepts is:
//   { type, props: { style, children } }
// where children is a string, a vdom, or an array of either.
//
// Constraints worth recalling here so the file is self-contained:
//   - Satori speaks only flexbox; no `display: table`. We hand-build a
//     column grid via nested flex divs and pre-compute per-column px
//     widths from the natural cell widths.
//   - Fonts are vendored under ./fonts (loaded once at module scope).
//     Don't depend on system fonts — the plugin is shipped to users.
//   - resvg-js renders SVG → PNG via napi-prebuilds (no Chromium, no
//     subprocess), giving a ~50 ms warm render in-process.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts')

// Color-emoji rendering: satori's text path uses the DejaVu fonts above
// (no color-emoji glyphs), so emoji codepoints would render as tofu (□).
// satori exposes `loadAdditionalAsset(code='emoji', segment)` for this:
// the hook supplies a per-emoji SVG data URI that satori inlines into
// the rendered glyph slot. We pull from jsDelivr's Twemoji mirror
// (pinned to @15.1.0 for reproducible asset bytes) and cache each
// fetched SVG under `os.tmpdir()/twemoji_cache/<cp>.svg`. First render
// of a given emoji does a single network hit; every subsequent render
// (same process or fresh) is a local disk read.
// Reference: vercel/satori README "Emojis" section; jdecked/twemoji asset layout.
const TWEMOJI_VERSION = '15.1.0'
const TW_CACHE = join(tmpdir(), 'twemoji_cache')
if (!existsSync(TW_CACHE)) mkdirSync(TW_CACHE, { recursive: true })

// Twemoji filename codepoint slug. Variation selector U+FE0F is stripped
// unless it's the only codepoint (e.g. keycap `1️⃣` → `0031-fe0f-20e3`,
// but `❤️` → `2764`, not `2764-fe0f`).
function toCodePoint(emoji: string): string {
  const cps: number[] = []
  for (const ch of emoji) cps.push(ch.codePointAt(0)!)
  const hasNonVS = cps.some(c => c !== 0xfe0f)
  const filtered = cps.length > 1 && hasNonVS ? cps.filter(c => c !== 0xfe0f) : cps
  return filtered.map(c => c.toString(16)).join('-')
}

async function loadEmoji(segment: string): Promise<string> {
  const cp = toCodePoint(segment)
  const cacheFile = join(TW_CACHE, `${cp}.svg`)
  let svgText: string
  if (existsSync(cacheFile)) {
    svgText = readFileSync(cacheFile, 'utf8')
  } else {
    const url = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@${TWEMOJI_VERSION}/assets/svg/${cp}.svg`
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`[render_table] twemoji miss for ${cp} (HTTP ${res.status})`)
      return ''
    }
    svgText = await res.text()
    writeFileSync(cacheFile, svgText)
    console.error(`[render_table] twemoji cached ${cp}.svg`)
  }
  return `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`
}

// Load once at module scope. If a font file is missing, throw at import
// time rather than at render time — the missing-fonts state is a build/
// install bug, not a per-request failure mode.
const FONT_REG = readFileSync(join(FONTS_DIR, 'DejaVuSans.ttf'))
const FONT_BOLD = readFileSync(join(FONTS_DIR, 'DejaVuSans-Bold.ttf'))
const FONT_MONO = readFileSync(join(FONTS_DIR, 'DejaVuSansMono.ttf'))

const SATORI_FONTS = [
  { name: 'DejaVu Sans', data: FONT_REG, weight: 400 as const, style: 'normal' as const },
  { name: 'DejaVu Sans', data: FONT_BOLD, weight: 700 as const, style: 'normal' as const },
  { name: 'DejaVu Sans Mono', data: FONT_MONO, weight: 400 as const, style: 'normal' as const },
]

type VNode = { type: string; props: { style?: any; children?: any } }
type Child = VNode | string

const h = (type: string, style: any, children?: Child | Child[]): VNode => ({
  type,
  props: { style, children },
})

type Row = string[]

function parseTable(md: string): { header: Row; rows: Row[] } | null {
  const lines = md.trim().split('\n')
  if (lines.length < 2) return null
  const splitRow = (l: string): Row => {
    const parts = l.split('|').map(s => s.trim())
    if (parts.length > 1 && parts[0] === '') parts.shift()
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  const header = splitRow(lines[0])
  if (header.length === 0) return null
  const rows = lines.slice(2).map(splitRow)
  const w = header.length
  for (const r of rows) while (r.length < w) r.push('')
  return { header, rows }
}

// Returns inline VNode/string children for a cell. Recognizes `code`,
// **bold**, *italic* (italic falls back to regular weight + tinted color
// since we don't ship an italic font — Satori would otherwise synthesize
// from regular at lower quality).
function inlineMd(s: string): Child[] {
  const out: Child[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push(buf); buf = '' } }
  let i = 0
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > 0) {
        flush()
        out.push(h('span', {
          fontFamily: 'DejaVu Sans Mono',
          background: '#2c2c2c',
          padding: '1px 4px',
          borderRadius: 3,
          fontSize: 13,
          color: '#fbb',
        }, s.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > 0) {
        flush()
        out.push(h('span', { fontWeight: 700, color: '#fff' }, s.slice(i + 2, end)))
        i = end + 2
        continue
      }
    }
    if (s[i] === '*') {
      const end = s.indexOf('*', i + 1)
      if (end > 0) {
        flush()
        out.push(h('span', { fontStyle: 'italic', color: '#aef' }, s.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    buf += s[i]
    i++
  }
  flush()
  return out
}

function visibleLen(s: string): number {
  return s.replace(/\*\*?|`/g, '').length
}

// Approximates satori's word-wrap behavior: greedily fits words into a
// colChars-wide column, breaking at every space where the next word
// would overflow. Returns the resulting line count.
//
// Why not the naive `Math.ceil(naked / colWidth)`: that heuristic counts
// 7-char "Pure JS" in a 7-char column as 1 line, but satori wraps at
// the space when actual rendered glyph widths exceed the
// 7-char × 7.5-px-per-char budget. The naive count under-estimated row
// height and the last row got clipped under the SVG `height`. The
// +24 slack at the bottom of buildTree is the matching safety margin
// when a tight near-overflow case fools the per-word simulation too.
//
// A word longer than colWidth still occupies (at least) one line — we
// don't break inside a word. Multi-word cells with tight fits return
// the same line count as the char-density heuristic; ragged cells
// (long words separated by spaces) get a more accurate count.
//
// **Markup awareness** (2026-05-11): the simulator now inflates a
// word's virtual char count to account for inline-markup render width:
//   - Each backtick in a code span renders with 4 px horizontal padding
//     via `inlineMd`. Two backticks per span × ~4 px ≈ +1 virtual char
//     at CHAR_PX=7.5, so we just add the backtick count to the visible
//     length.
//   - Bold runs (`**…**`) render at ~1.10× the glyph stride of regular
//     weight; we scale the word's virtual length accordingly.
// Without this, header cells like "`vis_a` since `a`" in a 13-char
// column estimate to 1 line but satori wraps them to 2. Fixture:
// tests/fixtures/post_a_plus_g_table.md.
//
// **Single-word overflow** (2026-05-11, A1.2): the original
// "single-word = 1 line" floor (a word longer than colWidth still
// counted as 1 line because we don't break inside a word) under-counted
// satori's actual wrap behavior. Concrete failure: `**post-A+G**` in a
// width-8 column. Virtual length after bold scaling is `ceil(8 × 1.10)
// = 9`, exceeds colWidth=8, satori actually wraps it to 2 lines, but
// the old code reported 1. Fix: when curLen ends up > colWidth, count
// `ceil(curLen / colWidth)` lines total (strictly additive — never
// reports fewer lines than the old formula).
//
// **Break-word partial-fit** (2026-05-11, A1.3): with `wordBreak:
// 'break-word'` on the cell (added in the same commit), satori
// consumes the *remaining space on the current line* when a too-long
// word arrives, then wraps the tail. The pre-A1.3 simulator instead
// wrapped the whole long word to a new line, then charged ceil(len/
// colWidth)-1 overflow lines — over-counting by 1 line whenever the
// previous content left non-trivial space on the current line.
// Concrete failure: `the verylongunhyphenatedwordlandsinashavedcolumn
// pattern` in a 43-char shaved column. Render = 2 lines ("the very…
// shav" / "edcolumn pattern"), pre-A1.3 simulator = 3, leaving ~20 px
// of blank canvas below the row. A1.3 path now mirrors break-word:
// fill remaining current-line space (filledOnCurrent) and only charge
// extra lines for the residual.
export function countWrappedLines(cell: string, colWidth: number): number {
  const wordsRaw = cell.split(/\s+/).filter(Boolean)
  if (wordsRaw.length === 0) return 1
  const wordsVirtual = wordsRaw.map(w => {
    const codeBackticks = (w.match(/`/g) || []).length
    const visible = w.replace(/\*\*?|`/g, '').length
    const hasBold = w.includes('**')
    const len = visible + codeBackticks
    return Math.ceil(hasBold ? len * 1.1 : len)
  })
  let lines = 1
  let curLen = 0
  for (const wordLen of wordsVirtual) {
    if (curLen === 0) {
      curLen = wordLen
    } else if (curLen + 1 + wordLen <= colWidth) {
      curLen += 1 + wordLen
    } else if (wordLen > colWidth) {
      // Break-word partial-fit: word can't fit anywhere intact, so
      // satori consumes remaining space on the current line, then
      // wraps the tail across as many full-width lines as needed.
      const filledOnCurrent = colWidth - curLen - 1
      if (filledOnCurrent > 0) {
        const remaining = wordLen - filledOnCurrent
        const fullExtraLines = Math.ceil(remaining / colWidth)
        lines += fullExtraLines
        curLen = remaining - (fullExtraLines - 1) * colWidth
      } else {
        // No room on current line for any partial chunk → wrap the
        // whole word to a new line; the overflow check below picks up
        // any remaining multi-line spillover.
        lines++
        curLen = wordLen
      }
    } else {
      // Word fits on a fresh line — just wrap.
      lines++
      curLen = wordLen
    }
    // Single-word overflow (A1.2): a word (or accumulated line) longer
    // than colWidth still wraps. The break-word path above keeps
    // curLen ≤ colWidth by construction; this check covers the
    // first-word-of-line case where curLen was set unconditionally.
    if (curLen > colWidth) {
      const overflowLines = Math.ceil(curLen / colWidth) - 1
      lines += overflowLines
      curLen -= overflowLines * colWidth
    }
  }
  return lines
}

// Adaptive column widths: start at the natural max-cell-width per column.
// If the row is wider than maxTotalChars, shave the widest column by 1
// each pass until we fit (or every column is at the floor of 12).
function computeColWidths(header: Row, rows: Row[], maxTotalChars = 90): number[] {
  const n = header.length
  const natural: number[] = new Array(n).fill(0)
  for (let c = 0; c < n; c++) {
    natural[c] = Math.max(visibleLen(header[c]), ...rows.map(r => visibleLen(r[c] ?? '')))
  }
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= maxTotalChars) return natural.map(w => Math.max(w, 6))
  const widths = [...natural]
  let guard = 200
  while (widths.reduce((a, b) => a + b, 0) > maxTotalChars && guard-- > 0) {
    const max = Math.max(...widths)
    if (max <= 12) break
    for (let c = 0; c < n; c++) if (widths[c] === max) widths[c] = max - 1
  }
  return widths.map(w => Math.max(w, 6))
}

const CHAR_PX = 7.5
const PAD_X = 12
const PAD_Y = 8
const FONT_PX = 14
const LINE_PX = 20

function buildTree(
  header: Row,
  rows: Row[],
): { root: VNode; widthPx: number } {
  const colChars = computeColWidths(header, rows)
  const colPx = colChars.map(c => Math.round(c * CHAR_PX) + PAD_X * 2)
  const widthPx = colPx.reduce((a, b) => a + b, 0) + 2

  // wordBreak: 'break-all' is the canonical satori knob for "let the
  // text layer break inside a token when no UAX #14 opportunity fits."
  // It sets `allowBreakWord` in satori's internal linebreak pass, which
  // falls back to grapheme-level splits. Without it, a long
  // unhyphenated token (e.g. `verylongunhyphenatedword…`) has zero
  // break opportunities and renders on a single visual line —
  // overflowing the cell's `width` and visually colliding with the
  // next column. The count path (`countWrappedLines`) already predicts
  // such tokens as multi-line; this aligns the render with the count.
  // Reference: satori CSS table; issue #484 (don't rely on span-wrap);
  // issue #532 (overflow:hidden doesn't clip — so break-all is the only
  // honest fix).
  const cellNode = (cell: string, w: number, isHeader: boolean): VNode =>
    h('div', {
      display: 'flex',
      width: w,
      padding: `${PAD_Y}px ${PAD_X}px`,
      borderRight: '1px solid #444',
      fontSize: FONT_PX,
      color: isHeader ? '#fff' : '#ddd',
      background: isHeader ? '#2d3340' : 'transparent',
      fontWeight: isHeader ? 600 : 400,
      wordBreak: 'break-word',
    },
      h('div', {
        display: 'flex',
        flexWrap: 'wrap',
        maxWidth: '100%',
        lineHeight: 1.4,
      }, inlineMd(cell)),
    )

  const rowNode = (row: Row, isHeader = false, zebra = false): VNode => {
    const bg = isHeader ? '#2d3340' : zebra ? '#1f1f1f' : '#262626'
    return h('div', {
      display: 'flex',
      background: bg,
      borderBottom: '1px solid #444',
    }, row.map((c, ci) => cellNode(c, colPx[ci], isHeader)))
  }

  const root = h('div', {
    display: 'flex',
    flexDirection: 'column',
    background: '#181818',
    border: '1px solid #444',
    fontFamily: 'DejaVu Sans',
    width: widthPx,
  }, [rowNode(header, true), ...rows.map((r, i) => rowNode(r, false, i % 2 === 1))])

  return { root, widthPx }
}

// Pure: parse a markdown pipe-table and render it to a PNG buffer.
// Returns null for malformed input (missing separator, 0 columns, 0
// data rows). Throws only on a satori/resvg internal failure — the
// caller should catch and skip the PNG, leaving the codeblock chunk
// in place.
//
// **Canvas-height strategy** (2026-05-11, A1.4): we pass `height:
// undefined` to satori so it auto-computes the layout height from the
// actual rendered row stack. resvg-js then picks the height up from
// the SVG's `height=` attribute. This replaces a prior approach
// (A1–A1.3) that ran a `countWrappedLines` simulator + a fixed +24 px
// slack to predict canvas height — that simulator could only
// approximate satori's glyph-width budget and ran into systematic
// under-counts on exact-fit cells (absorbed by the +24 slack) and
// over-counts on shaved-column tables with long inline-code chips
// (left ~30 px of blank canvas below the last row). Letting satori
// measure itself eliminates both error directions: the canvas matches
// the actual row stack pixel-for-pixel, with no slack and no
// simulator-vs-render mismatch.
// `countWrappedLines` is retained, exported, and unit-tested as a
// **diagnostic / count predictor** (useful for tests + future
// instrumentation), but it is no longer used to size the SVG canvas.
// References: vercel/satori Discussion #614 (dynamic-height pattern);
// `@altano/satori-fit-text` (community library doing the same).
export async function renderMarkdownTableToPng(md: string): Promise<Buffer | null> {
  const parsed = parseTable(md)
  if (!parsed) return null
  const { header, rows } = parsed
  if (header.length === 0 || rows.length === 0) return null

  const { root, widthPx } = buildTree(header, rows)
  const svg = await satori(root as any, {
    width: widthPx,
    // height omitted → satori auto-computes from the layout.
    fonts: SATORI_FONTS,
    loadAdditionalAsset: async (code: string, segment: string) => {
      if (code === 'emoji') return await loadEmoji(segment)
      return ''
    },
  } as any)
  const png = new Resvg(svg, { background: '#181818' }).render().asPng()
  return Buffer.from(png)
}
