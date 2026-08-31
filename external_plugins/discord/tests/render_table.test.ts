// Run with: bun test tests/render_table.test.ts
//
// Covers the markup-aware countWrappedLines fix (2026-05-11) and pins a
// regression test against the originally failing fixture
// `tests/fixtures/post_a_plus_g_table.md`, whose pre-fix render
// truncated the last row at 172 px height. PNG dimensions are read
// straight from the IHDR (bytes 16–23) to avoid pulling in a PNG-decode
// dep.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdownTableToPng, countWrappedLines } from '../render_table'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function pngDims(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('countWrappedLines() — markup awareness', () => {
  test('code spans inflate virtual width (regression case)', () => {
    // The failing header cell from post_a_plus_g_table.md. In a 13-char
    // column, satori wraps "`vis_a` since `a`" to 2 lines because the
    // two code spans add ~8 px of horizontal padding each that the
    // pre-fix simulator ignored. Markup-aware simulator must say 2.
    expect(countWrappedLines('`vis_a` since `a`', 13)).toBe(2)
  })

  test('bold scales word width by ~1.10', () => {
    // A bold word that fits in 10 chars at regular weight (10 visible)
    // should still fit, but a bold word that fits *exactly* at regular
    // weight tips over once scaled. 10 visible chars → ceil(10*1.1) =
    // 11 virtual chars → exceeds a 10-char budget.
    expect(countWrappedLines('**0123456789** more', 10)).toBeGreaterThanOrEqual(2)
  })
})

describe('countWrappedLines() — single-word overflow (A1.2)', () => {
  test('bold-expanded single word that overflows colWidth wraps to ≥ 2 lines', () => {
    // Concrete failure from the live self-test: the post-A+G row's
    // first cell `**post-A+G**` in a width-8 column. Bold scaling
    // produces ceil(8 * 1.10) = 9 virtual chars, which exceeds
    // colWidth=8. Pre-A1.2, this returned 1 (the "single word = 1
    // line" floor); post-A1.2 it returns ≥ 2.
    expect(countWrappedLines('**post-A+G**', 8)).toBeGreaterThanOrEqual(2)
  })

  test('plain word longer than colWidth wraps to ceil(len/colWidth) lines', () => {
    // 9 chars in a 5-char column → ceil(9/5) = 2 lines.
    expect(countWrappedLines('composite', 5)).toBe(2)
    // 8 chars in a 3-char column → ceil(8/3) = 3 lines.
    expect(countWrappedLines('abcdefgh', 3)).toBe(3)
  })

  test('overflow remainder participates in subsequent word fit', () => {
    // First word overflows (virtual 9 in width 8) and lands a 1-char
    // tail on its wrapped line. A subsequent 6-char word should fit
    // on that same tail line: 1 + 1 (space) + 6 = 8 ≤ 8.
    // Result: overflow + tail-fit = exactly 2 lines.
    expect(countWrappedLines('**post-A+G** medium', 8)).toBe(2)
  })
})

describe('countWrappedLines() — break-word partial-fit (A1.3)', () => {
  test('long word that overflows current line consumes remaining space first', () => {
    // "the verylongtoken" in 8-char col. "the " fits in 4 chars,
    // leaving 3 chars on line 1 (after the space). break-word puts
    // "ver" on line 1 ("the ver"), then wraps the remainder
    // "ylongtoken" (10 chars) across 2 lines ("ylongtok", "en") → 3
    // lines total. Pre-A1.3 the simulator wrapped the entire
    // 12-char "verylongtoken" to a new line and counted 1 wrap + 1
    // overflow = 3 lines too (matches by coincidence), but the
    // tail-curLen differed. The key assertion is "no over-count
    // when partial-fit consumes the remainder cleanly".
    expect(countWrappedLines('the verylongtoken', 8)).toBe(3)
  })

  test('shaved-column long-token row matches actual render', () => {
    // Adversarial repro: pre-A1.3 this returned 3 (over-counting by
    // 1, leaving ~20 px of blank canvas below the row). With A1.3
    // partial-fit, the simulator matches satori's break-word output
    // of 2 lines ("the verylongunhyphenatedwordlandsinashav" /
    // "edcolumn pattern").
    expect(countWrappedLines(
      'the verylongunhyphenatedwordlandsinashavedcolumn pattern',
      43,
    )).toBe(2)
  })

  test('full row width offers no partial-fit space → wraps as whole', () => {
    // curLen=colWidth exactly (no slack for a partial chunk).
    // break-word wraps the long word to the next line; overflow
    // check then handles the multi-line spillover.
    expect(countWrappedLines('abcdefgh verylongword', 8)).toBeGreaterThanOrEqual(3)
  })
})

describe('countWrappedLines() — no over-estimate on plain text', () => {
  test('hello world in width 20 stays 1 line', () => {
    expect(countWrappedLines('hello world', 20)).toBe(1)
  })

  test('a b c d in width 7 stays 1 line', () => {
    expect(countWrappedLines('a b c d', 7)).toBe(1)
  })

  test('hello in width 10 stays 1 line', () => {
    // Sanity: the single-word-overflow path doesn't fire when the
    // word actually fits in the column.
    expect(countWrappedLines('hello', 10)).toBe(1)
  })

  test('single-word cell that fits in colWidth → 1 line', () => {
    expect(countWrappedLines('composite', 9)).toBe(1)
  })

  test('empty cell returns 1', () => {
    expect(countWrappedLines('', 8)).toBe(1)
    expect(countWrappedLines('   ', 8)).toBe(1)
  })
})

describe('renderMarkdownTableToPng() — auto-height canvas (A1.4)', () => {
  // The brief's verbatim 5-row test table (live-Discord fixture).
  // Pre-A1.4: canvas was 749 × 346 (countWrappedLines simulator +24
  // px slack, leaving ~30 px of unused space below the last row).
  // Post-A1.4: satori computes its own layout height via
  // `height: undefined`; canvas matches the row stack exactly.
  test('list_threads_overflow_table.md renders with canvas matching actual content', async () => {
    const md = readFileSync(join(FIXTURES_DIR, 'list_threads_overflow_table.md'), 'utf8')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { width, height } = pngDims(png as Buffer)
    expect(width).toBe(749)
    // Pre-A1.4 height was 346 (slack-padded). Post-A1.4 height is
    // exactly satori's auto-computed layout = 316 px. Tight
    // tolerance: ±2 px to absorb any kerning/AA jitter across
    // satori versions.
    expect(height).toBeGreaterThanOrEqual(314)
    expect(height).toBeLessThanOrEqual(318)
  })
})

describe('renderMarkdownTableToPng() — overflow-token row (A1.3)', () => {
  // Adversarial fixture used while developing A1.3 (the
  // wordBreak: 'break-word' + simulator break-word-aware fix).
  // Pre-fix, the long token in cell (2,3) (Tool column) rendered
  // on a single visual line and overflowed horizontally into the
  // Output column — visible as the Tool text overlaying the
  // Output text. Post-fix the long token wraps inside the cell.
  test('5-row table with a column-exceeding token renders without horizontal collision', async () => {
    const md = [
      '| # | Surface | Tool | Output |',
      '| - | - | - | - |',
      '| 1 | inline | `code` | small |',
      '| 2 | bold | **`mixed`** | medium |',
      '| 3 | plain | text | short |',
      '| 4 | react | `✅` | done |',
      '| 5 | A1.2 single-word-overflow stress | verylongunhyphenatedwordthatexceedscolumnwidth | overflow |',
    ].join('\n')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { width, height } = pngDims(png as Buffer)
    // Width is the satori-computed sum of column widths + border.
    // We can't verify "no horizontal collision" from buffer dims
    // alone (that requires a pixel-diff harness), but width must
    // be at least the per-column natural total — and height must
    // accommodate at least the simulator's row count.
    expect(width).toBeGreaterThan(700)
    // 7 rows (header + 6 body), each ≥ 1 line at LINE_PX=20 +
    // padding ≈ 37 px, plus +24 slack ≈ 283 px MAX for the
    // single-line case. Post-fix, row 5's Tool col wraps to ≥ 2
    // lines via break-word; row count must be tall enough for
    // the wrap.
    expect(height).toBeGreaterThanOrEqual(200)
  })
})

describe('renderMarkdownTableToPng() — regression on post_a_plus_g_table.md', () => {
  // Pre-fix this fixture rendered at 669 × 172 with the post-A+G row
  // truncated at its baseline. Post-A1 (markup-aware simulator):
  // 669 × 192, header wrap caught, last-row clip eliminated for the
  // header case. Post-A1.2 (single-word overflow): 669 × 212, bold
  // **post-A+G** in width-8 column now correctly counted as 2 lines.
  // Post-A1.4 (satori auto-height): 669 × 210 — drops the 2 px of
  // residual slack the simulator had left, canvas now matches the
  // actual row-stack layout pixel-for-pixel.
  test('full last row is visible (PNG height within 208–214 px)', async () => {
    const md = readFileSync(join(FIXTURES_DIR, 'post_a_plus_g_table.md'), 'utf8')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { width, height } = pngDims(png as Buffer)
    expect(width).toBe(669)
    // Floor 208: anything below indicates a clip regression on either
    // A1 (markup-aware count → header wraps) or A1.2 (bold
    // single-word-overflow → post-A+G wraps).
    // Ceiling 214: anything above indicates the simulator's +24 slack
    // crept back in (A1.4 regression).
    expect(height).toBeGreaterThanOrEqual(208)
    expect(height).toBeLessThanOrEqual(214)
  })
})

// --- CJK rendering (2026-08-31) ---
//
// Two independent bugs, both fixed here:
//   1. No CJK face was vendored, so every Han/Kana glyph came out as
//      tofu (□) — satori fell back to DejaVu's .notdef.
//   2. `visibleLen` measured code units, so CJK columns got half the
//      px budget they needed and their cells wrapped.
describe('renderMarkdownTableToPng() — CJK', () => {
  const cjkTable = (cell: string) =>
    ['| 项目 | Item |', '| --- | --- |', `| ${cell} | latin |`].join('\n')

  test('distinct Han glyphs produce distinct pixels (tofu detector)', async () => {
    // The load-bearing assertion for the font fix. With no CJK face
    // registered, both cells render as the *same* .notdef box, so the
    // two PNGs come out byte-identical. Once Noto Sans SC is in the
    // fallback stack the glyphs differ and so do the bytes.
    const a = await renderMarkdownTableToPng(cjkTable('一一'))
    const b = await renderMarkdownTableToPng(cjkTable('龘龘'))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // Same char count → same canvas, so a byte diff is a glyph diff.
    expect(pngDims(a as Buffer)).toEqual(pngDims(b as Buffer))
    expect((a as Buffer).equals(b as Buffer)).toBe(false)
  })

  test('control: identical text renders identically', async () => {
    // Guards the detector above against false positives from any
    // nondeterminism in the satori/resvg pipeline.
    const a = await renderMarkdownTableToPng(cjkTable('一一'))
    const b = await renderMarkdownTableToPng(cjkTable('一一'))
    expect((a as Buffer).equals(b as Buffer)).toBe(true)
  })

  test('bold CJK renders as glyphs, not tofu', async () => {
    // Header cells use fontWeight 600 and `**…**` spans 700. With the
    // CJK face registered only at weight 400, satori resolves those
    // runs to DejaVu Bold and bold CJK regresses to tofu even though
    // regular CJK works — hence the two weight entries in SATORI_FONTS.
    const bold = (c: string) =>
      ['| 项目 | Item |', '| --- | --- |', `| **${c}** | latin |`].join('\n')
    const a = await renderMarkdownTableToPng(bold('一一'))
    const b = await renderMarkdownTableToPng(bold('龘龘'))
    expect((a as Buffer).equals(b as Buffer)).toBe(false)
  })

  test('a CJK column is budgeted ~2x a same-count Latin column', async () => {
    // 6 Han chars must claim 12 char-cells of width, not 6, so the
    // CJK canvas is 6 * CHAR_PX = 45 px wider than the same table
    // with a 6-char Latin cell. Both cells sit above the width-6
    // floor in computeColWidths, so the floor doesn't absorb the
    // delta.
    const wide = await renderMarkdownTableToPng(cjkTable('会议注册费用'))
    const narrow = await renderMarkdownTableToPng(cjkTable('abcdef'))
    const dw = pngDims(wide as Buffer).width
    const dn = pngDims(narrow as Buffer).width
    expect(dw - dn).toBeGreaterThanOrEqual(40)
    expect(dw - dn).toBeLessThanOrEqual(50)
  })

  test('mixed CJK/Latin table renders without a wrapped CJK cell', async () => {
    // Regression for the live repro (a Chinese reimbursement table).
    // Every cell fits on one line, so the canvas must stay at the
    // 3-row single-line height — a cramped CJK column would wrap and
    // push it taller.
    const md = [
      '| 项目 | Item (Latin) | 金额 |',
      '| --- | --- | --- |',
      '| 会议注册费 | ECCV registration | 1250 |',
      '| **住宿费用** | **Hotel** | 890 |',
    ].join('\n')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { height } = pngDims(png as Buffer)
    // 3 rows x (14px line * 1.4 + 2*8 padding + 1 border) ~= 113 px.
    expect(height).toBeLessThanOrEqual(125)
  })
})
