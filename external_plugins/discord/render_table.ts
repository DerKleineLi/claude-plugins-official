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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fonts')

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
): { root: VNode; widthPx: number; heightEstPx: number } {
  const colChars = computeColWidths(header, rows)
  const colPx = colChars.map(c => Math.round(c * CHAR_PX) + PAD_X * 2)
  const widthPx = colPx.reduce((a, b) => a + b, 0) + 2

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

  // Height estimate: per row, max wrapped-line count across cells. Plus
  // vertical padding once per row, plus row borders. The +6 is slack so
  // line-height rounding never clips the last row (Satori truncates
  // content past its `height`).
  let totalContentPx = 0
  for (const r of [header, ...rows]) {
    const lines = r.map((cell, c) => {
      const naked = visibleLen(cell)
      return Math.max(1, Math.ceil(naked / Math.max(colChars[c], 1)))
    })
    const maxLines = Math.max(...lines)
    totalContentPx += maxLines * LINE_PX + PAD_Y * 2 + 1
  }
  const heightEstPx = Math.ceil(totalContentPx + 6)

  return { root, widthPx, heightEstPx }
}

// Pure: parse a markdown pipe-table and render it to a PNG buffer.
// Returns null for malformed input (missing separator, 0 columns, 0
// data rows). Throws only on a satori/resvg internal failure — the
// caller should catch and skip the PNG, leaving the codeblock chunk
// in place.
export async function renderMarkdownTableToPng(md: string): Promise<Buffer | null> {
  const parsed = parseTable(md)
  if (!parsed) return null
  const { header, rows } = parsed
  if (header.length === 0 || rows.length === 0) return null

  const { root, widthPx, heightEstPx } = buildTree(header, rows)
  const svg = await satori(root as any, {
    width: widthPx,
    height: heightEstPx,
    fonts: SATORI_FONTS,
  })
  const png = new Resvg(svg, { background: '#181818' }).render().asPng()
  return Buffer.from(png)
}
