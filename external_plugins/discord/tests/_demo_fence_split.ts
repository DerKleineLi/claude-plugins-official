// Live-verify helper. Builds a long fenced code block in the middle of
// some prose, runs chunk() on it, and prints each emitted chunk with
// a separator so the parent agent can sanity-check Discord rendering.
//
// Run with: bun run tests/_demo_fence_split.ts

import { chunk, getOpenFenceAtEnd } from '../format'

const sep = (label: string) => `\n${'='.repeat(70)}\n ${label}\n${'='.repeat(70)}`

function demo(label: string, text: string, limit: number) {
  const out = chunk(text, limit)
  console.log(sep(`${label}  (input ${text.length} chars, limit ${limit}, ${out.length} chunks)`))
  for (let i = 0; i < out.length; i++) {
    const open = getOpenFenceAtEnd(out[i])
    console.log(`\n--- chunk ${i + 1}/${out.length} (len ${out[i].length}, open-at-end=${open ? `${open.fenceLen}-tick:${open.lang || '<bare>'}` : 'null'}) ---`)
    console.log(out[i])
  }
}

// Canonical edge case: long ```python fence in the middle of prose,
// split forced by limit smaller than the fenced body.
const code = ('def step_' + 'x'.repeat(40) + '():\n').repeat(15)
demo(
  'split mid-content of an open ```python fence (3 chunks)',
  'Intro paragraph before the code block.\n\n```python\n' + code + '```\n\nOutro paragraph after.',
  400,
)

// 4-backtick variant.
const fourCode = ('outer line ' + 'y'.repeat(30) + '\n').repeat(10)
demo(
  '4-backtick fence variant (split mid-content, lang=empty)',
  '````\n' + fourCode + '````',
  300,
)

// Inline backticks inside an open fence — must not confuse detector.
const inline = ('let x = `' + 'z'.repeat(20) + '`;\n').repeat(15)
demo(
  'inline backticks inside ```ts fence (split mid-content)',
  '```ts\n' + inline + '```',
  300,
)

// Two adjacent fences, split lands between them — no synthetic injection.
const blockPy = '```python\n' + 'x = 1234567\n'.repeat(10) + '```'
const blockTs = '```ts\n' + 'let y = 12;\n'.repeat(10) + '```'
demo(
  'two adjacent fences, split between them (no synthetic markers)',
  blockPy + '\n\n' + blockTs,
  200,
)
