// Render a TeX display-block formula to PNG via mathjax-full (TeX → SVG)
// + @resvg/resvg-js (SVG → PNG). Pure JS, no browser, no Python sidecar.
//
// Wired into format.ts → buildReplyMessages so `$$...$$`, `\[...\]`, and
// the `\begin{equation|align|aligned|...}` envs in an outbound reply
// ship as a PNG attachment in their own Discord message (alongside the
// raw .tex source).
//
// Constraints worth recalling here:
//   - MathJax SVGs are transparent and use `currentColor` for glyphs.
//     On Discord's dark theme that renders black-on-transparent (i.e.
//     invisible). We rewrite `currentColor` → white and let resvg-js
//     paint a dark background underneath.
//   - The MathJax adapter is initialized once at module scope. The
//     init costs ~50 ms; per-call render is 30–40 ms warm.
//   - We pull MathJax's `viewBox` and force explicit pixel width/height
//     on the <svg>, since resvg's "intrinsic-size" fallback for ex-unit
//     SVGs gives us tiny output at default zoom.

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import 'mathjax-full/js/input/tex/AllPackages.js'
import { Resvg } from '@resvg/resvg-js'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor as any)

const tex = new TeX({ packages: ['base', 'ams'] })
const svgOut = new SVG({ fontCache: 'none' })
const doc = mathjax.document('', { InputJax: tex, OutputJax: svgOut })

const SCALE = 2.0
const PX_PER_UNIT = 32 / 500 // probe-validated: 1 ex ≈ 500 mathjax units → 32 px at scale 2

function tex2svg(latex: string): string {
  const node = doc.convert(latex, {
    display: true,
    em: 16 * SCALE,
    ex: 8 * SCALE,
    containerWidth: 1280,
  })
  return adaptor.innerHTML(node)
}

// Pure: render a display TeX expression to a PNG buffer. Throws on
// malformed TeX (MathJax surfaces parse errors as thrown Errors). The
// caller catches and falls back to inline ```tex source.
export async function renderFormulaToPng(texSource: string): Promise<Buffer> {
  let svg = tex2svg(texSource)

  const vbMatch = svg.match(/viewBox="([^"]+)"/)
  if (vbMatch) {
    const [, , w, h] = vbMatch[1].split(/\s+/).map(parseFloat)
    const pxW = Math.max(1, Math.round(w * PX_PER_UNIT))
    const pxH = Math.max(1, Math.round(h * PX_PER_UNIT))
    svg = svg.replace(/\s(?:width|height)="[^"]*"/g, '')
    svg = svg.replace(/<svg([^>]*)>/, `<svg$1 width="${pxW}" height="${pxH}">`)
  }

  // Discord dark-theme readable: paint glyphs white, sit on a dark bg.
  svg = svg.replace(/currentColor/g, '#ffffff')

  const png = new Resvg(svg, {
    background: '#2c2f33',
    fitTo: { mode: 'zoom', value: 1.0 },
  }).render().asPng()
  return Buffer.from(png)
}
