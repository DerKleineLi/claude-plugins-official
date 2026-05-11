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

describe('renderMarkdownTableToPng() — regression on post_a_plus_g_table.md', () => {
  // Pre-fix this fixture rendered at 669 × 172 with the post-A+G row
  // truncated at its baseline. Post-A1 (markup-aware simulator):
  // 669 × 192, header wrap caught, last-row clip eliminated for the
  // header case. Post-A1.2 (single-word overflow): 669 × 212, bold
  // **post-A+G** in width-8 column now correctly counted as 2 lines.
  test('full last row is visible (PNG height ≥ 208 px)', async () => {
    const md = readFileSync(join(FIXTURES_DIR, 'post_a_plus_g_table.md'), 'utf8')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { width, height } = pngDims(png as Buffer)
    expect(width).toBe(669)
    // Need ≥ 208 px to contain header (2 lines) + row 1 (still 1 line
    // in the simulator — slack absorbs the missed wrap satori does)
    // + row 2 (1 line) + post-A+G row (now 2 lines via A1.2) + close.
    // Pre-A1 baseline was 172 (clipped); regression floor of 208
    // means anything < 208 indicates a regression in either A1 or
    // A1.2.
    expect(height).toBeGreaterThanOrEqual(208)
  })
})
