// Display-width helpers shared by the two table paths.
//
// Both outputs of a markdown table sized their columns from
// `String.prototype.length`, i.e. UTF-16 code units:
//   - render_table.ts budgets `chars * CHAR_PX` px per column, and
//   - format.ts pads the `table-N.md` fallback with `.padEnd`.
// A CJK ideograph is one code unit but occupies two monospace cells
// (and ~1em ≈ 2 * CHAR_PX in the PNG), so every CJK column came out
// about half the space it needed: cells wrapped in the PNG and the
// .md attachment misaligned by one cell per ideograph.
//
// East_Asian_Width is not exposed to JS regex (`\p{...}` covers only
// General_Category / Script / binary properties), so the Wide +
// Fullwidth ranges are spelled out below. Range table follows the
// widely used `is-fullwidth-code-point` set (Unicode EAW W and F).
//
// Astral codepoints (> U+FFFF) count as 2 unconditionally. That is
// both correct for the common cases (emoji render ~1em wide, CJK
// Ext-B is Wide) and behaviour-preserving: `.length` already charged
// them 2 as a surrogate pair, so no existing width shifts.

export function isFullWidthCodePoint(cp: number): boolean {
  if (cp > 0xffff) return true
  if (cp < 0x1100) return false
  return (
    cp <= 0x115f || // Hangul Jamo init. consonants
    cp === 0x2329 || // 〈 LEFT-POINTING ANGLE BRACKET
    cp === 0x232a || // 〉 RIGHT-POINTING ANGLE BRACKET
    // CJK Radicals Supplement .. Enclosed CJK Letters and Months,
    // minus U+303F (IDEOGRAPHIC HALF FILL SPACE, which is Narrow).
    (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
    (cp >= 0x3250 && cp <= 0x4dbf) || // Enclosed CJK .. CJK Ext-A
    (cp >= 0x4e00 && cp <= 0xa4c6) || // CJK Unified .. Yi Radicals
    (cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical Forms
    (cp >= 0xfe30 && cp <= 0xfe6b) || // CJK Compatibility Forms
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    isWideEmoji(cp)
  )
}

// BMP symbols that Unicode 9.0 promoted from Narrow to Wide when it
// gave emoji-presentation characters EAW=W. The classic
// `is-fullwidth-code-point` range table predates that revision and
// still calls these Narrow, which left `✅`-bearing rows one cell
// short in the aligned `.md` fallback. Astral emoji (U+1F300+) need
// no entry here — every codepoint above U+FFFF is already 2.
function isWideEmoji(cp: number): boolean {
  return (
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  )
}

// Width of `s` in monospace cells: 2 per East-Asian Wide/Fullwidth
// codepoint, 1 otherwise. Iterates codepoints, so a surrogate pair
// counts once (as 2, per isFullWidthCodePoint).
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += isFullWidthCodePoint(ch.codePointAt(0)!) ? 2 : 1
  return w
}

// `.padEnd` for display width: pads with spaces until `displayWidth`
// reaches `width`. Never truncates (mirrors padEnd), so an over-wide
// cell is returned unchanged.
export function padEndWidth(s: string, width: number): string {
  const pad = width - displayWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}
