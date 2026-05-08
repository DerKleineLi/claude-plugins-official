// Run with: bun test tests/format.test.ts

import { describe, test, expect } from 'bun:test'
import {
  chunk,
  wrapPipeTablesAsCodeBlocks,
  detectOversizedTable,
  splitTableIntoMessages,
  buildReplyMessages,
  findTablesInLines,
  normalizeTableWidths,
  TABLE_MULTI_MESSAGE_THRESHOLD,
} from '../format'

describe('chunk()', () => {
  test('passthrough for short text', () => {
    expect(chunk('hello', 2000)).toEqual(['hello'])
  })

  test('splits at paragraph boundary, consuming the \\n\\n', () => {
    const a = 'a'.repeat(1500)
    const b = 'b'.repeat(1500)
    const t = a + '\n\n' + b
    const out = chunk(t, 2000)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  test('splits at line boundary if no \\n\\n in window', () => {
    const t = ('a'.repeat(100) + '\n').repeat(30)
    const out = chunk(t, 2000)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(2000)
      // No mid-line cut: every chunk's last 'a'-run is exactly 100 chars,
      // i.e. each chunk ends on a line boundary (after trim) or is a
      // multiple of full lines.
      const lastRun = c.split('\n').filter(s => s.length > 0).pop() ?? ''
      expect(lastRun.length).toBe(100)
    }
  })

  test('splits at word boundary if no linebreaks', () => {
    const word = 'a'.repeat(50)
    const t = (word + ' ').repeat(100)
    const out = chunk(t, 2000)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out.slice(0, -1)) {
      expect(c.length).toBeLessThanOrEqual(2000)
      // Every interior chunk should end on a complete word (50 a's),
      // never mid-word.
      expect(c.endsWith(word)).toBe(true)
    }
  })

  test('hard-cuts a single word > limit (no infinite loop)', () => {
    const t = 'a'.repeat(5000)
    const out = chunk(t, 2000)
    expect(out.length).toBe(3)
    expect(out.join('')).toBe(t)
    expect(out[0].length).toBe(2000)
    expect(out[1].length).toBe(2000)
    expect(out[2].length).toBe(1000)
  })

  test('trims trailing whitespace from chunks', () => {
    const t = 'a'.repeat(1990) + '\n\n' + 'b'.repeat(1000)
    const out = chunk(t, 2000)
    expect(out.length).toBe(2)
    expect(/\s$/.test(out[0])).toBe(false)
  })

  test('exact-limit text passes through unsplit', () => {
    const t = 'a'.repeat(2000)
    expect(chunk(t, 2000)).toEqual([t])
  })
})

describe('findTablesInLines()', () => {
  test('detects a single table', () => {
    const lines = ['| a | b |', '| - | - |', '| 1 | 2 |']
    expect(findTablesInLines(lines)).toEqual([{ start: 0, end: 3 }])
  })

  test('rejects a stray | in prose as a row', () => {
    const lines = [
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      'The symbol | is a pipe.',
    ]
    // Header has 3 pipes; stray-pipe prose has 1 → table ends at row 3.
    expect(findTablesInLines(lines)).toEqual([{ start: 0, end: 3 }])
  })

  test('handles tables without leading/trailing pipes', () => {
    const lines = ['a | b', '--- | ---', '1 | 2']
    // Header has 1 pipe → minPipes = max(2, 0) = 2. Row has 1 pipe → fails minPipes check, no table.
    // (Markdown tables without surrounding pipes are uncommon in Discord context;
    // we accept the mild false-negative for robustness against stray-pipe prose.)
    const tables = findTablesInLines(lines)
    expect(tables).toEqual([])
  })

  test('detects multiple tables in one document', () => {
    const lines = [
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'gap',
      '',
      '| c | d |',
      '| - | - |',
      '| 3 | 4 |',
    ]
    expect(findTablesInLines(lines)).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ])
  })
})

describe('normalizeTableWidths()', () => {
  test('aligns a plain 3-col 4-row table to uniform line width', () => {
    const t = `| a | b | c |\n| --- | --- | --- |\n| 1 | 22 | 333 |\n| 4 | 55 | 666 |`
    const out = normalizeTableWidths(t)
    const outLines = out.split('\n')
    expect(outLines.length).toBe(4)
    // Every emitted line is the same length (true alignment).
    const widths = outLines.map(l => l.length)
    expect(new Set(widths).size).toBe(1)
    // Separator dashes match column widths (each col padded to ≥3 chars).
    expect(outLines[1]).toMatch(/^\| -{3,} \| -{3,} \| -{3,} \|$/)
    // Cells include their content.
    expect(outLines[2]).toContain('1')
    expect(outLines[2]).toContain('22')
    expect(outLines[2]).toContain('333')
  })

  test('preserves backticks and other markdown literally', () => {
    const t = `| name | val |\n| --- | --- |\n| \`id\` | 5 |`
    const out = normalizeTableWidths(t)
    expect(out).toContain('`id`')
    // Width is computed from `.length`, so 4-char ``id`` sets col 0 width to 4.
    const lines = out.split('\n')
    expect(new Set(lines.map(l => l.length)).size).toBe(1)
  })

  test('pads empty cells with spaces', () => {
    const t = `| a | b | c |\n| --- | --- | --- |\n|  | 22 |  |`
    const out = normalizeTableWidths(t)
    const lines = out.split('\n')
    expect(new Set(lines.map(l => l.length)).size).toBe(1)
    // The empty-cell row still has 3 cells separated by `|`.
    const row3Cells = lines[2].split('|').filter(s => s.length > 0)
    expect(row3Cells.length).toBe(3)
  })

  test('preserves : alignment markers in separator', () => {
    const t = `| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |`
    const out = normalizeTableWidths(t)
    const lines = out.split('\n')
    // Four colons total: left-align (1) + center (2) + right-align (1).
    const colonCount = (lines[1].match(/:/g) || []).length
    expect(colonCount).toBe(4)
    expect(lines[1]).toMatch(/^\| :-+ \| :-+: \| -+: \|$/)
  })

  test('single-row table (header + separator only) still normalizes', () => {
    const t = `| a | bb |\n| --- | --- |`
    const out = normalizeTableWidths(t)
    const lines = out.split('\n')
    expect(lines.length).toBe(2)
    expect(new Set(lines.map(l => l.length)).size).toBe(1)
  })

  test('mismatched column counts: shorter rows padded with empty cells', () => {
    const t = `| a | b | c |\n| --- | --- | --- |\n| 1 |`
    const out = normalizeTableWidths(t)
    const lines = out.split('\n')
    expect(new Set(lines.map(l => l.length)).size).toBe(1)
    // The padded short row still has 3 cell separators.
    expect(lines[2].split('|').length).toBe(5) // ['', cell1, cell2, cell3, '']
  })
})

describe('wrapPipeTablesAsCodeBlocks()', () => {
  test('wraps a plain table in fences (with normalized widths)', () => {
    const t = `before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter`
    const out = wrapPipeTablesAsCodeBlocks(t)
    // Normalization pads cells to width-3 (the min), so cells become 'a  ', 'b  ', etc.
    expect(out).toContain('```\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n```')
    expect(out.startsWith('before')).toBe(true)
    expect(out.endsWith('after')).toBe(true)
  })

  test('preserves links inside cells', () => {
    const t = `| name | url |\n| --- | --- |\n| foo | [link](https://x.y) |`
    const out = wrapPipeTablesAsCodeBlocks(t)
    expect(out).toContain('[link](https://x.y)')
    expect(out.startsWith('```')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
  })

  test('does not double-wrap a pre-existing code block containing pipes', () => {
    const t = '```\n| not | a | table |\n```'
    const out = wrapPipeTablesAsCodeBlocks(t)
    // Original two fences only — no extra wrapping.
    const fenceCount = (out.match(/```/g) || []).length
    expect(fenceCount).toBe(2)
    expect(out).toBe(t)
  })

  test('no-op on text without tables', () => {
    const t = 'just some prose, no tables here.'
    expect(wrapPipeTablesAsCodeBlocks(t)).toBe(t)
  })

  test('does not extend table into prose with stray pipe', () => {
    const t = `| a | b |\n| --- | --- |\n| 1 | 2 |\nThe symbol | denotes division.`
    const out = wrapPipeTablesAsCodeBlocks(t)
    // The `| 1 | 2 |` row is the last row; prose stays unwrapped.
    // Cells normalized to width-3.
    expect(out).toContain('```\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n```\nThe symbol')
  })

  test('wraps multiple tables independently', () => {
    const t = `| a | b |\n| - | - |\n| 1 | 2 |\n\nbetween\n\n| c | d |\n| - | - |\n| 3 | 4 |`
    const out = wrapPipeTablesAsCodeBlocks(t)
    const fenceCount = (out.match(/```/g) || []).length
    expect(fenceCount).toBe(4)
  })
})

describe('detectOversizedTable()', () => {
  test('returns null for a short table', () => {
    const t = `| a | b |\n| - | - |\n| 1 | 2 |`
    expect(detectOversizedTable(t, 1900)).toBe(null)
  })

  test('detects a table whose wrapped size exceeds threshold', () => {
    const header = '| col1 | col2 |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 100 }, (_, i) => `| row${i}_x | row${i}_y |`)
    const tbl = [header, sep, ...rows].join('\n')
    const result = detectOversizedTable(tbl, 1900)
    expect(result).not.toBe(null)
    expect(result?.table).toBe(tbl)
    expect(result?.pre).toBe('')
    expect(result?.post).toBe('')
  })

  test('preserves pre and post prose around an oversized table', () => {
    const header = '| col1 | col2 |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 100 }, (_, i) => `| row${i}_x | row${i}_y |`)
    const tbl = [header, sep, ...rows].join('\n')
    const t = `intro paragraph\n\n${tbl}\n\noutro paragraph`
    const result = detectOversizedTable(t, 1900)
    expect(result).not.toBe(null)
    expect(result?.pre.trim()).toBe('intro paragraph')
    expect(result?.post.trim()).toBe('outro paragraph')
    expect(result?.table).toBe(tbl)
  })
})

describe('splitTableIntoMessages()', () => {
  test('splits a long table into multiple messages, each with header+sep', () => {
    const header = '| col1 | col2 |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 100 }, (_, i) => `| row${i}_x | row${i}_y |`)
    const tbl = [header, sep, ...rows].join('\n')
    const out = splitTableIntoMessages('', tbl, '', 1900, 2000)
    expect(out.length).toBeGreaterThanOrEqual(2)
    // Each chunk is a valid fenced block with header content + separator.
    // After normalization, headers are padded — match by content (e.g. 'col1') not exact string.
    for (const m of out) {
      expect(m.content).toContain('col1')
      expect(m.content).toContain('col2')
      expect(m.content).toContain('---')
      expect(m.content).toContain('```')
      expect(m.content.length).toBeLessThanOrEqual(2000)
    }
    // Continuations carry the marker; the first does not.
    expect(out[0].content.startsWith('_continued (')).toBe(false)
    for (let k = 1; k < out.length; k++) {
      expect(out[k].content.startsWith('_continued (')).toBe(true)
    }
  })

  test('multi-message split: every chunk shares the same column widths', () => {
    // Mix short and long rows so the un-normalized widths would differ
    // chunk-to-chunk if normalization weren't applied to the full table.
    const header = '| col1 | col2 |'
    const sep = '| --- | --- |'
    const shortRows = Array.from({ length: 50 }, (_, i) => `| s${i} | t${i} |`)
    const longRows = Array.from({ length: 50 }, (_, i) => `| longrow${i}_xx | longrow${i}_yy |`)
    const tbl = [header, sep, ...shortRows, ...longRows].join('\n')
    const out = splitTableIntoMessages('', tbl, '', 1900, 2000)
    expect(out.length).toBeGreaterThanOrEqual(2)

    // Extract the header line (the line immediately after the opening fence)
    // from each chunk and confirm they're identical across chunks.
    const chunkHeaders = out.map(m => {
      const lines = m.content.split('\n')
      const fenceIdx = lines.indexOf('```')
      return lines[fenceIdx + 1]
    })
    expect(new Set(chunkHeaders).size).toBe(1)

    // Sanity: the shared header has been normalized to the longest-row width.
    expect(chunkHeaders[0]).toMatch(/^\| col1\s+\| col2\s+\|$/)
  })

  test('attachment fallback when one row exceeds the per-message budget', () => {
    const header = '| huge |'
    const sep = '| --- |'
    const giantRow = `| ${'x'.repeat(2500)} |`
    const tbl = [header, sep, giantRow].join('\n')
    const out = splitTableIntoMessages('', tbl, '', 1900, 2000)
    const withFiles = out.find(m => m.files && m.files.length > 0)
    expect(withFiles).toBeDefined()
    expect(withFiles!.content.toLowerCase()).toContain('attachment')
    expect(withFiles!.files![0].name).toBe('table.md')
  })

  test('attachment fallback preserves pre/post prose around the table', () => {
    const header = '| h |'
    const sep = '| - |'
    const giant = `| ${'y'.repeat(2500)} |`
    const tbl = [header, sep, giant].join('\n')
    const out = splitTableIntoMessages('intro', tbl, 'outro', 1900, 2000)
    expect(out.length).toBe(3)
    expect(out[0].content).toBe('intro')
    expect(out[1].files).toBeDefined()
    expect(out[2].content).toBe('outro')
  })

  test('chunks long pre/post prose using the standard chunker', () => {
    const header = '| c1 | c2 |'
    const sep = '| - | - |'
    const rows = Array.from({ length: 100 }, (_, i) => `| r${i}_x | r${i}_y |`)
    const tbl = [header, sep, ...rows].join('\n')
    const longPre = ('a'.repeat(100) + '\n').repeat(30) // 3030 chars
    const out = splitTableIntoMessages(longPre, tbl, '', 1900, 2000)
    // Pre prose chunks come first; should be at least 2 (3030 / ~2000).
    const preChunks = out.filter(m => m.content.startsWith('a'))
    expect(preChunks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('buildReplyMessages() — end-to-end routing', () => {
  test('plain text → single chunk', () => {
    const out = buildReplyMessages('hello world', 2000)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('hello world')
    expect(out[0].files).toBeUndefined()
  })

  test('text with a small table → wrapped, single message', () => {
    const t = `| a | b |\n| - | - |\n| 1 | 2 |`
    const out = buildReplyMessages(t, 2000)
    expect(out.length).toBe(1)
    expect(out[0].content).toContain('```')
  })

  test('text with a large table → multi-message split', () => {
    const header = '| col1 | col2 |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 200 }, (_, i) => `| row${i}_x | row${i}_y |`)
    const tbl = [header, sep, ...rows].join('\n')
    const out = buildReplyMessages(tbl, 2000)
    expect(out.length).toBeGreaterThanOrEqual(2)
    // Every message stays under the chunk limit.
    for (const m of out) {
      expect(m.content.length).toBeLessThanOrEqual(2000)
    }
  })

  test('long prose without tables uses paragraph-aware chunker', () => {
    const t = ('paragraph text. '.repeat(50) + '\n\n').repeat(10)
    const out = buildReplyMessages(t, 2000)
    expect(out.length).toBeGreaterThan(1)
    for (const m of out) {
      expect(m.content.length).toBeLessThanOrEqual(2000)
    }
  })

  test('TABLE_MULTI_MESSAGE_THRESHOLD is 1900 (sanity)', () => {
    expect(TABLE_MULTI_MESSAGE_THRESHOLD).toBe(1900)
  })
})
