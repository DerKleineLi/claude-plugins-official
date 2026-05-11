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

describe('countWrappedLines() — no over-estimate on plain text', () => {
  test('hello world in width 20 stays 1 line', () => {
    expect(countWrappedLines('hello world', 20)).toBe(1)
  })

  test('a b c d in width 7 stays 1 line', () => {
    expect(countWrappedLines('a b c d', 7)).toBe(1)
  })

  test('single-word cell always 1 line', () => {
    expect(countWrappedLines('composite', 9)).toBe(1)
    expect(countWrappedLines('composite', 5)).toBe(1) // word > width, still 1 line
  })

  test('empty cell returns 1', () => {
    expect(countWrappedLines('', 8)).toBe(1)
    expect(countWrappedLines('   ', 8)).toBe(1)
  })
})

describe('renderMarkdownTableToPng() — regression on post_a_plus_g_table.md', () => {
  // Pre-fix this fixture rendered at 669 × 172 with the post-A+G row
  // truncated at its baseline. Post-fix the simulator correctly
  // identifies the header's 2-line wrap and the table renders tall
  // enough to contain the full last row.
  test('full last row is visible (PNG height ≥ 188 px)', async () => {
    const md = readFileSync(join(FIXTURES_DIR, 'post_a_plus_g_table.md'), 'utf8')
    const png = await renderMarkdownTableToPng(md)
    expect(png).not.toBeNull()
    const { width, height } = pngDims(png as Buffer)
    expect(width).toBe(669)
    // Need at least 188 px to contain header (2 lines, ~57 px) + row 1
    // (~57 px once observed) + row 2 + row 3 (~37 px each) + close.
    // The pre-fix value was 172. Anything ≥ 188 indicates the
    // simulator absorbed the header wrap that pre-fix it missed.
    expect(height).toBeGreaterThanOrEqual(188)
  })
})
