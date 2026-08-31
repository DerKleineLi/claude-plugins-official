// Run with: bun test tests/text_width.test.ts
//
// Covers the East-Asian display-width fix (2026-08-31). Both table
// outputs used to size columns from `String.length`, which charges a
// CJK ideograph 1 cell instead of 2 — the PNG budgeted CJK columns at
// half width and the `table-N.md` fallback misaligned by one cell per
// ideograph.

import { describe, test, expect } from 'bun:test'
import { displayWidth, padEndWidth, isFullWidthCodePoint } from '../text_width'

describe('displayWidth()', () => {
  test('ASCII is unchanged (1 cell per char)', () => {
    expect(displayWidth('hello world')).toBe(11)
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('| --- |')).toBe(7)
  })

  test('Latin-1 / symbols stay narrow', () => {
    // The € sign and an em dash are Narrow — a CJK-aware width must
    // not accidentally widen the existing Latin tables.
    expect(displayWidth('€1,250.00')).toBe(9)
    expect(displayWidth('Hotel — 5 nights')).toBe(16)
  })

  test('Han ideographs count 2', () => {
    expect(displayWidth('项目')).toBe(4)
    expect(displayWidth('会议注册费')).toBe(10)
  })

  test('Kana and Hangul count 2', () => {
    expect(displayWidth('ひらがな')).toBe(8)
    expect(displayWidth('カタカナ')).toBe(8)
    expect(displayWidth('한국어')).toBe(6)
  })

  test('fullwidth punctuation counts 2', () => {
    expect(displayWidth('，')).toBe(2)
    expect(displayWidth('（）')).toBe(4)
  })

  test('mixed CJK/Latin sums per-codepoint', () => {
    // 2 Han (4) + space (1) + 4 Latin (4) = 9
    expect(displayWidth('备注 note')).toBe(9)
  })

  test('astral codepoints count 2 (matches the old .length behaviour)', () => {
    // Surrogate pairs were already charged 2 by `.length`; keeping
    // them at 2 means no existing column width shifted.
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('𠮷')).toBe(2) // CJK Ext-B
  })

  test('emoji-presentation symbols are Wide under Unicode 9+', () => {
    expect(displayWidth('✅')).toBe(2)
    expect(displayWidth('❌')).toBe(2)
    expect(displayWidth('⌚')).toBe(2)
  })

  test('narrow symbols near the emoji block stay 1', () => {
    // U+2764 (❤ heart) and U+26A0 (⚠ warning) are EAW=Neutral, not
    // Wide — they must not be swept up by the emoji-Wide ranges.
    expect(displayWidth('❤')).toBe(1)
    expect(displayWidth('⚠')).toBe(1)
    // U+303F is the documented Narrow hole inside the CJK block.
    expect(displayWidth('〿')).toBe(1)
  })
})

describe('isFullWidthCodePoint()', () => {
  test('boundaries of the CJK Unified block', () => {
    expect(isFullWidthCodePoint(0x4e00)).toBe(true)
    expect(isFullWidthCodePoint(0x4dbf)).toBe(true) // CJK Ext-A tail
    // U+4DC0..U+4DFF is Yijing Hexagram Symbols — Neutral, not Wide,
    // and it sits between CJK Ext-A and CJK Unified.
    expect(isFullWidthCodePoint(0x4dc0)).toBe(false)
    expect(isFullWidthCodePoint(0x10ff)).toBe(false) // just below Hangul Jamo
  })
})

describe('padEndWidth()', () => {
  test('pads to display width, not code-unit length', () => {
    expect(padEndWidth('项目', 8)).toBe('项目    ') // 4 cells + 4 spaces
    expect(padEndWidth('ab', 5)).toBe('ab   ')
  })

  test('never truncates an over-wide cell (mirrors padEnd)', () => {
    expect(padEndWidth('会议注册费', 4)).toBe('会议注册费')
  })

  test('exact fit adds nothing', () => {
    expect(padEndWidth('项目', 4)).toBe('项目')
  })
})
