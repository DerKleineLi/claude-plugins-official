// Run with: bun test tests/elements.test.ts

import { describe, test, expect } from 'bun:test'
import { parseElements } from '../parse_elements'
import { langToExt } from '../lang_extensions'

describe('langToExt()', () => {
  test('canonical lang names', () => {
    expect(langToExt('python')).toBe('py')
    expect(langToExt('typescript')).toBe('ts')
    expect(langToExt('rust')).toBe('rs')
    expect(langToExt('json')).toBe('json')
  })

  test('aliases', () => {
    expect(langToExt('py')).toBe('py')
    expect(langToExt('ts')).toBe('ts')
    expect(langToExt('js')).toBe('js')
    expect(langToExt('yml')).toBe('yaml')
    expect(langToExt('rb')).toBe('rb')
    expect(langToExt('shell')).toBe('sh')
    expect(langToExt('golang')).toBe('go')
  })

  test('case-insensitive lookup', () => {
    expect(langToExt('PYTHON')).toBe('py')
    expect(langToExt('TypeScript')).toBe('ts')
  })

  test('whitespace tolerated', () => {
    expect(langToExt('  python  ')).toBe('py')
  })

  test('unknown / empty lang returns null', () => {
    expect(langToExt('madeuplang')).toBe(null)
    expect(langToExt('')).toBe(null)
    expect(langToExt('   ')).toBe(null)
  })
})

describe('parseElements() — basics', () => {
  test('plain prose stays as a single element', () => {
    const out = parseElements('just some text, no elements')
    expect(out).toEqual([{ kind: 'prose', text: 'just some text, no elements' }])
  })

  test('single table in middle of prose', () => {
    const t = `before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter`
    const out = parseElements(t)
    expect(out.map(e => e.kind)).toEqual(['prose', 'table', 'prose'])
    expect(out[0]).toMatchObject({ kind: 'prose' })
    expect(out[1]).toMatchObject({
      kind: 'table',
      mdSource: '| a | b |\n|---|---|\n| 1 | 2 |',
    })
    expect(out[2]).toMatchObject({ kind: 'prose' })
  })

  test('two tables back-to-back, separated only by a blank line', () => {
    const t =
      `| a | b |\n|---|---|\n| 1 | 2 |\n\n` +
      `| c | d |\n|---|---|\n| 3 | 4 |`
    const out = parseElements(t)
    const kinds = out.map(e => e.kind)
    expect(kinds).toEqual(['table', 'prose', 'table'])
    expect((out[0] as any).mdSource).toContain('| a |')
    expect((out[2] as any).mdSource).toContain('| c |')
  })

  test('code-block fencing a markdown table inside: table stays as code', () => {
    const t = '```md\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
    const out = parseElements(t)
    expect(out).toEqual([
      { kind: 'code', lang: 'md', ext: 'md', source: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ])
  })

  test('no-lang code-block ships as code-N.txt', () => {
    const t = '```\nplain\n```'
    const out = parseElements(t)
    expect(out).toEqual([{ kind: 'code', lang: '', ext: 'txt', source: 'plain' }])
  })

  test('unknown-lang code-block ships as code-N.txt', () => {
    const t = '```madeuplang\nfoo\n```'
    const out = parseElements(t)
    expect(out).toEqual([
      { kind: 'code', lang: 'madeuplang', ext: 'txt', source: 'foo' },
    ])
  })

  test('inline-tagged fence (```inline) stays inline as prose', () => {
    const t = '```inline\nkeep me inline\n```'
    const out = parseElements(t)
    expect(out).toEqual([{ kind: 'prose', text: '```inline\nkeep me inline\n```' }])
  })

  test('inline-tag is case-insensitive and whitespace-trimmed', () => {
    expect(parseElements('```Inline\nfoo\n```')).toEqual([
      { kind: 'prose', text: '```Inline\nfoo\n```' },
    ])
    expect(parseElements('```  INLINE  \nfoo\n```')).toEqual([
      { kind: 'prose', text: '```  INLINE  \nfoo\n```' },
    ])
  })

  test('code-block with known lang becomes a code element', () => {
    const t = '```python\nprint("hi")\n```'
    const out = parseElements(t)
    expect(out).toEqual([
      { kind: 'code', lang: 'python', ext: 'py', source: 'print("hi")' },
    ])
  })

  test('prose + code with known lang surrounded by prose', () => {
    const t = 'before\n```ts\nlet x = 1\n```\nafter'
    const out = parseElements(t)
    const kinds = out.map(e => e.kind)
    expect(kinds).toEqual(['prose', 'code', 'prose'])
    expect(out[1]).toMatchObject({ kind: 'code', lang: 'ts', ext: 'ts', source: 'let x = 1' })
  })

  test('unknown-lang fence between two prose pieces ships as code-N.txt', () => {
    const t = 'A.\n```madeup\nfoo\n```\nB.'
    const out = parseElements(t)
    expect(out.map(e => e.kind)).toEqual(['prose', 'code', 'prose'])
    expect(out[1]).toEqual({ kind: 'code', lang: 'madeup', ext: 'txt', source: 'foo' })
  })

  test('inline-tagged fence between two prose pieces coalesces', () => {
    const t = 'A.\n```inline\nfoo\n```\nB.'
    const out = parseElements(t)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({
      kind: 'prose',
      text: 'A.\n```inline\nfoo\n```\nB.',
    })
  })
})

describe('parseElements() — formulas', () => {
  test('$$...$$ on its own line is a formula', () => {
    const t = 'before\n\n$$E = mc^2$$\n\nafter'
    const out = parseElements(t)
    const kinds = out.map(e => e.kind)
    expect(kinds).toEqual(['prose', 'formula', 'prose'])
    expect(out[1]).toMatchObject({
      kind: 'formula',
      texSource: 'E = mc^2',
      delimiter: 'dollar',
    })
  })

  test('$...$ inline math does NOT trigger split', () => {
    const t = 'the constant $\\pi$ is irrational'
    const out = parseElements(t)
    expect(out).toEqual([{ kind: 'prose', text: 'the constant $\\pi$ is irrational' }])
  })

  test('multi-line $$...$$ formula', () => {
    const t = 'before\n$$\nx = 1\ny = 2\n$$\nafter'
    const out = parseElements(t)
    const kinds = out.map(e => e.kind)
    expect(kinds).toEqual(['prose', 'formula', 'prose'])
    expect((out[1] as any).texSource).toBe('x = 1\ny = 2')
  })

  test('\\[...\\] is a formula', () => {
    const t = 'before\\[E = mc^2\\]after'
    const out = parseElements(t)
    expect(out.map(e => e.kind)).toEqual(['prose', 'formula', 'prose'])
    expect(out[1]).toMatchObject({ kind: 'formula', delimiter: 'bracket', texSource: 'E = mc^2' })
  })

  test('\\begin{equation}...\\end{equation} is a formula', () => {
    const t = 'before\n\\begin{equation}\nE = mc^2\n\\end{equation}\nafter'
    const out = parseElements(t)
    expect(out.map(e => e.kind)).toEqual(['prose', 'formula', 'prose'])
    expect(out[1]).toMatchObject({ kind: 'formula', delimiter: 'env', texSource: 'E = mc^2' })
  })

  test('\\begin{align*}...\\end{align*} is a formula', () => {
    const t = '\\begin{align*}\nx &= 1 \\\\ y &= 2\n\\end{align*}'
    const out = parseElements(t)
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({ kind: 'formula', delimiter: 'env' })
  })

  test('formula inside a code block stays as code', () => {
    const t = '```python\nx = "$$E = mc^2$$"\n```'
    const out = parseElements(t)
    expect(out).toEqual([
      { kind: 'code', lang: 'python', ext: 'py', source: 'x = "$$E = mc^2$$"' },
    ])
  })

  test('formula inside a table block does not get pulled out separately', () => {
    // Pipe-tables get claimed before formulas, so a `$$x$$` cell stays
    // as part of the table source.
    const t = '| name | math |\n|---|---|\n| pi | $$\\pi$$ |'
    const out = parseElements(t)
    expect(out.length).toBe(1)
    expect(out[0]).toMatchObject({ kind: 'table' })
    expect((out[0] as any).mdSource).toContain('$$\\pi$$')
  })
})

describe('parseElements() — mixed', () => {
  test('prose + table + prose + formula + prose + code → 6 elements', () => {
    const t = [
      'A.',
      '',
      '| h | v |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'B.',
      '',
      '$$E = mc^2$$',
      '',
      'C.',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n')
    const out = parseElements(t)
    expect(out.map(e => e.kind)).toEqual([
      'prose', 'table', 'prose', 'formula', 'prose', 'code',
    ])
  })

  test('preserves document order with multiple elements of same kind', () => {
    const t = [
      '```py',
      'a = 1',
      '```',
      '',
      '$$x = 1$$',
      '',
      '```js',
      'let b = 2',
      '```',
      '',
      '$$y = 2$$',
    ].join('\n')
    const out = parseElements(t)
    const kinds = out.map(e => e.kind)
    // Prose between elements may or may not appear depending on whitespace,
    // but the non-prose order must match document order.
    const nonProse = out.filter(e => e.kind !== 'prose')
    expect(nonProse.map(e => e.kind)).toEqual(['code', 'formula', 'code', 'formula'])
    expect((nonProse[0] as any).lang).toBe('py')
    expect((nonProse[2] as any).lang).toBe('js')
  })
})
