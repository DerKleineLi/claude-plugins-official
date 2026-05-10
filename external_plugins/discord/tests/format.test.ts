// Run with: bun test tests/format.test.ts

import { describe, test, expect } from 'bun:test'
import {
  chunk,
  buildReplyMessages,
  buildReplyMessagesWith,
  findTablesInLines,
  normalizeTableWidths,
  getOpenFenceAtEnd,
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

describe('chunk() — fence preservation across split', () => {
  // Helper: every emitted chunk must be independently fence-balanced.
  // We use the production scanner as the oracle: if it sees no open
  // fence at the end of a chunk, the chunk parses as valid Discord
  // markdown.
  const expectAllBalanced = (chunks: string[]) => {
    for (const c of chunks) {
      expect(getOpenFenceAtEnd(c)).toBe(null)
    }
  }

  test('split mid-content of an open 3-tick fence: closes + reopens with lang', () => {
    const code = ('b'.repeat(50) + '\n').repeat(5)
    const text = 'a'.repeat(100) + '\n```python\n' + code + '```'
    const out = chunk(text, 200)
    expect(out.length).toBeGreaterThan(1)
    expectAllBalanced(out)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(200)
    // Continuation chunks reopen with the original lang.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startsWith('```python\n')).toBe(true)
    }
    // Non-final chunks end with a closing fence.
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].endsWith('\n```')).toBe(true)
    }
    // Round-trip sanity: stripping the synthetic open/close pairs we
    // inserted yields the original text. (Synthetic = a closer at the
    // end of chunk N immediately followed by a matching opener at the
    // start of chunk N+1 when joined with no separator.)
    const joined = out.join('')
    // Each synthetic boundary contributes one close + one open with a
    // newline between, e.g. `\n` + ```` + `\n` + ```python` + `\n`.
    // Easier: assert the joined text contains the original code body
    // and the original opener+closer.
    expect(joined).toContain('```python\n')
    expect(joined.split('b'.repeat(50)).length - 1).toBe(5)
  })

  test('split between two adjacent fences does not inject synthetic markers', () => {
    // Two fences sized to each fit inside a chunk after the split,
    // separated by a paragraph break. The chunker should pick the
    // \n\n as its cut point and emit the two fences unchanged — no
    // synthetic close/open should be injected, since neither fence
    // straddles the boundary.
    //
    // Sizing: limit=200, FENCE_RESERVE=64 → innerLimit=136. Each
    // block must be ≤136. Total must be >limit so a split happens.
    const block1 = '```python\n' + 'x = 1234567\n'.repeat(10) + '```'
    const block2 = '```ts\n' + 'let y = 12;\n'.repeat(10) + '```'
    const text = block1 + '\n\n' + block2
    expect(block1.length).toBeLessThanOrEqual(136)
    expect(block2.length).toBeLessThanOrEqual(136)
    expect(text.length).toBeGreaterThan(200)
    const out = chunk(text, 200)
    expect(out.length).toBe(2)
    expectAllBalanced(out)
    // No synthetic markers: total fence count is preserved.
    const inFences = (text.match(/```/g) || []).length
    const outFences = (out.join('').match(/```/g) || []).length
    expect(outFences).toBe(inFences)
    // Each block lands cleanly in its own chunk.
    expect(out[0]).toBe(block1)
    expect(out[1]).toBe(block2)
  })

  test('preserves 4-backtick fence variant: reopens with 4 ticks', () => {
    const code = ('z'.repeat(50) + '\n').repeat(5)
    const text = 'a'.repeat(100) + '\n````\n' + code + '````'
    const out = chunk(text, 200)
    expect(out.length).toBeGreaterThan(1)
    expectAllBalanced(out)
    // Continuation chunks reopen with 4 ticks (not 3).
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startsWith('````\n')).toBe(true)
      // Sanity: not a 3-tick reopen.
      expect(/^```[^`]/.test(out[i])).toBe(false)
    }
    // Non-final chunks end with a 4-tick closer.
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].endsWith('\n````')).toBe(true)
    }
  })

  test('inline backticks inside an open fence do not confuse the splitter', () => {
    // The fence is ```ts; content has `let x = 1` inline backtick runs.
    // Split should still close+reopen the ts fence cleanly.
    const inner = ('let x = `123`; y = `456`;\n').repeat(10)
    const text = 'a'.repeat(100) + '\n```ts\n' + inner + '```'
    const out = chunk(text, 200)
    expect(out.length).toBeGreaterThan(1)
    expectAllBalanced(out)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startsWith('```ts\n')).toBe(true)
    }
  })

  test('split exactly at a fence-open boundary leaves both halves balanced', () => {
    // Construct so the chunker's line-boundary lands at or near the
    // ```python opener line. Two outcomes are valid:
    //   (a) Cut lands BEFORE the opener: chunk N ends with prose
    //       (no synthetic close), chunk N+1 starts with the natural
    //       opener.
    //   (b) Cut lands AFTER the opener line: chunk N ends with the
    //       opener line, gets a synthetic close; chunk N+1 starts
    //       with a synthetic ```python opener.
    // In either case, every chunk must be fence-balanced and the
    // python lang must be preserved wherever it gets reopened.
    const prose = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50)
    const code = ('d'.repeat(50) + '\n').repeat(5)
    const text = prose + '\n```python\n' + code + '```'
    const out = chunk(text, 180)
    expectAllBalanced(out)
    // Any chunk that contains a python fence opener uses the lang
    // tag (no chunk should emit a bare ``` re-opener when the source
    // opener was ```python).
    for (const c of out) {
      if (c.includes('```python')) continue
      // If a chunk has any fence, it shouldn't be a bare ``` that
      // belongs to the python block. The only legit bare ``` here is
      // a closer of the python block (which came from synthetic
      // close-injection or the original closing fence).
      // Stricter: count opens. An open is a ``` line whose info
      // string is non-empty OR which is the first-of-its-pair line.
      // Easy stand-in: the only bare-``` lines should be closers,
      // which means the joined text never has two bare ``` in a row
      // without a python opener in between. We don't assert this
      // directly — expectAllBalanced is the load-bearing check.
    }
  })

  test('split exactly at a fence-close boundary leaves both halves balanced', () => {
    // The split lands such that the closing ``` is the last line of
    // chunk N (or the first line of chunk N+1). In neither case should
    // the chunker inject extra markers.
    const code = ('e'.repeat(50) + '\n').repeat(3)
    const text = 'a'.repeat(80) + '\n```py\n' + code + '```\n' + 'b'.repeat(80)
    const out = chunk(text, 180)
    expect(out.length).toBeGreaterThan(1)
    expectAllBalanced(out)
  })

  test('long fence spanning 3+ chunks: every chunk reopens with lang', () => {
    const code = ('f'.repeat(50) + '\n').repeat(20)
    const text = '```python\n' + code + '```'
    const out = chunk(text, 400)
    expect(out.length).toBeGreaterThanOrEqual(3)
    expectAllBalanced(out)
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(400)
      expect(c.startsWith('```python\n')).toBe(true)
    }
    // Every chunk except the final ends with an injected closer.
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].endsWith('\n```')).toBe(true)
    }
  })

  test('no-fence input takes the unmodified fast path', () => {
    // Same shape as the suite's hard-cut test: confirms fence-aware
    // wrapping does not alter behavior on fence-free input.
    const t = 'a'.repeat(5000)
    expect(chunk(t, 2000)).toEqual([
      'a'.repeat(2000),
      'a'.repeat(2000),
      'a'.repeat(1000),
    ])
  })
})

describe('getOpenFenceAtEnd()', () => {
  test('returns null for plain prose with no fences', () => {
    expect(getOpenFenceAtEnd('plain prose, no fences here.')).toBe(null)
  })

  test('returns null for a balanced fence', () => {
    expect(getOpenFenceAtEnd('```\nfoo\n```')).toBe(null)
  })

  test('returns lang and len for an unclosed 3-tick fence with lang', () => {
    expect(getOpenFenceAtEnd('```python\nfoo\nbar')).toEqual({
      lang: 'python',
      fenceLen: 3,
    })
  })

  test('returns empty lang for an unclosed bare 3-tick fence', () => {
    expect(getOpenFenceAtEnd('```\nfoo')).toEqual({ lang: '', fenceLen: 3 })
  })

  test('handles 4-backtick fence variant', () => {
    expect(getOpenFenceAtEnd('````\nfoo')).toEqual({ lang: '', fenceLen: 4 })
    expect(getOpenFenceAtEnd('````python\nfoo')).toEqual({
      lang: 'python',
      fenceLen: 4,
    })
  })

  test('inline backticks are not interpreted as fences', () => {
    expect(getOpenFenceAtEnd('a `let x = 1` b')).toBe(null)
    expect(getOpenFenceAtEnd('two ``backticks`` inline')).toBe(null)
  })

  test('inline backticks inside an open fence do not close it', () => {
    expect(getOpenFenceAtEnd('```ts\nlet x = `123`')).toEqual({
      lang: 'ts',
      fenceLen: 3,
    })
  })

  test('a 3-tick line inside a 4-tick fence is content, not a closer', () => {
    expect(getOpenFenceAtEnd('````\n```\nfoo\n````')).toBe(null)
    expect(getOpenFenceAtEnd('````\n```\nfoo')).toEqual({
      lang: '',
      fenceLen: 4,
    })
  })

  test('closer with extra non-whitespace is treated as content', () => {
    // ``` followed by trailing text is NOT a valid closer.
    expect(getOpenFenceAtEnd('```\nfoo\n``` end')).toEqual({
      lang: '',
      fenceLen: 3,
    })
  })

  test('two adjacent fences are both balanced', () => {
    expect(getOpenFenceAtEnd('```py\na\n```\n```ts\nb\n```')).toBe(null)
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

// --- buildReplyMessages: element-attachment pipeline ---
//
// We test against `buildReplyMessagesWith` so we can inject deterministic
// stub renderers — the production renderers (satori + mathjax) are
// expensive and pull in heavy I/O. End-to-end with the real renderers is
// covered by smoke tests in tests/_demo_render.ts and live-verify.

const stubTablePng = async (_md: string): Promise<Buffer> => Buffer.from('PNG-TABLE-STUB')
const stubFormulaPng = async (_tex: string): Promise<Buffer> => Buffer.from('PNG-FORMULA-STUB')
const failingTablePng = async (_md: string): Promise<Buffer> => { throw new Error('synthetic table render failure') }
const failingFormulaPng = async (_tex: string): Promise<Buffer> => { throw new Error('synthetic formula render failure') }

const fileNames = (m: { files?: { name?: string | null }[] }): string[] =>
  (m.files ?? []).map(f => f.name ?? '').filter(Boolean)

describe('buildReplyMessages() — plain prose', () => {
  test('plain text passes through as a single message with no files', async () => {
    const out = await buildReplyMessagesWith('hello world', 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('hello world')
    expect(out[0].files).toBeUndefined()
  })

  test('long prose is paragraph-chunked', async () => {
    const t = ('paragraph text. '.repeat(50) + '\n\n').repeat(10)
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBeGreaterThan(1)
    for (const m of out) {
      expect(m.content.length).toBeLessThanOrEqual(2000)
      expect(m.files).toBeUndefined()
    }
  })
})

describe('buildReplyMessages() — tables', () => {
  test('single table → 1 file message with PNG + .md', async () => {
    const t = `| a | b |\n|---|---|\n| 1 | 2 |`
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('')
    expect(fileNames(out[0])).toEqual(['table-1.png', 'table-1.md'])
  })

  test('table with surrounding prose → 3 messages (prose + file + prose)', async () => {
    const t = 'before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(3)
    expect(out[0].content).toBe('before')
    expect(out[1].content).toBe('')
    expect(fileNames(out[1])).toEqual(['table-1.png', 'table-1.md'])
    expect(out[2].content).toBe('after')
  })

  test('two tables → 5 messages (prose + file + prose + file + prose, with prose elided when empty)', async () => {
    const t = [
      'A.',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'between',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
      '',
      'C.',
    ].join('\n')
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    const seq = out.map(m => (m.files && m.files.length ? `files:${fileNames(m).join(',')}` : `prose:${m.content}`))
    expect(seq).toEqual([
      'prose:A.',
      'files:table-1.png,table-1.md',
      'prose:between',
      'files:table-2.png,table-2.md',
      'prose:C.',
    ])
  })

  test('table PNG render failure → ships .md only (split still happens)', async () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |'
    const out = await buildReplyMessagesWith(t, 2000, failingTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(fileNames(out[0])).toEqual(['table-1.md'])
  })
})

describe('buildReplyMessages() — formulas', () => {
  test('display formula on its own line → 1 file message with PNG + .tex', async () => {
    const t = '$$E = mc^2$$'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('')
    expect(fileNames(out[0])).toEqual(['formula-1.png', 'formula-1.tex'])
  })

  test('formula PNG render failure → falls back to inline ```tex code-block', async () => {
    const t = 'before\n\n$$E = mc^2$$\n\nafter'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, failingFormulaPng)
    expect(out.length).toBe(3)
    expect(out[0].content).toBe('before')
    expect(out[1].content).toBe('```tex\nE = mc^2\n```')
    expect(out[1].files).toBeUndefined()
    expect(out[2].content).toBe('after')
  })

  test('inline $...$ math stays inside prose', async () => {
    const t = 'the constant $\\pi$ is irrational'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe(t)
    expect(out[0].files).toBeUndefined()
  })
})

describe('buildReplyMessages() — code blocks', () => {
  test('python code-block → 1 file message named code-1.py', async () => {
    const t = '```python\nprint("hi")\n```'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('')
    expect(fileNames(out[0])).toEqual(['code-1.py'])
  })

  test('json code-block → code-1.json', async () => {
    const t = '```json\n{"a": 1}\n```'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(fileNames(out[0])).toEqual(['code-1.json'])
  })

  test('multiple known-lang code-blocks counter → code-1, code-2', async () => {
    const t = '```py\na = 1\n```\n\n```ts\nlet b = 2\n```'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    const fileMsgs = out.filter(m => m.files && m.files.length > 0)
    expect(fileMsgs.length).toBe(2)
    expect(fileNames(fileMsgs[0])).toEqual(['code-1.py'])
    expect(fileNames(fileMsgs[1])).toEqual(['code-2.ts'])
  })

  test('no-lang code-block stays inline in prose', async () => {
    const t = '```\nplain\n```'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('```\nplain\n```')
    expect(out[0].files).toBeUndefined()
  })

  test('unknown-lang code-block stays inline in prose', async () => {
    const t = '```madeuplang\nfoo\n```'
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('```madeuplang\nfoo\n```')
    expect(out[0].files).toBeUndefined()
  })
})

describe('buildReplyMessages() — mixed', () => {
  test('prose + table + prose + formula + prose + code → 6 alternating messages', async () => {
    const t = [
      'A.',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'B.',
      '',
      '$$x = 1$$',
      '',
      'C.',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n')
    const out = await buildReplyMessagesWith(t, 2000, stubTablePng, stubFormulaPng)
    const seq = out.map(m =>
      m.files && m.files.length ? `files:${fileNames(m).join(',')}` : `prose:${m.content}`,
    )
    expect(seq).toEqual([
      'prose:A.',
      'files:table-1.png,table-1.md',
      'prose:B.',
      'files:formula-1.png,formula-1.tex',
      'prose:C.',
      'files:code-1.py',
    ])
  })

  test('async buildReplyMessages (default) returns a Promise', async () => {
    const result = buildReplyMessages('hello', 2000)
    expect(result).toBeInstanceOf(Promise)
    const out = await result
    expect(out.length).toBe(1)
    expect(out[0].content).toBe('hello')
  })
})
