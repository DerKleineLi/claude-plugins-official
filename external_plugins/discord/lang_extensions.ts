// Map highlight.js language IDs (and common aliases) to canonical file
// extensions. Used by the element parser: a fenced code block with a
// recognized lang tag gets shipped as a file attachment named
// `code-N.<ext>` so Discord's inline preview pane can render it with
// syntax highlighting.
//
// Discord ships highlight.js v10.6.0 in its client. The list below is
// a curated subset of the bundled languages — extend as needed. Keys
// are normalized (lowercased, trimmed) before lookup, so callers don't
// need to pre-normalize.
//
// Reference: https://gist.github.com/ThaTiemsz/a5a4000085d8e92e81877e4114897456

const LANG_TO_EXT: Record<string, string> = {
  // JS / TS
  javascript: 'js', js: 'js',
  typescript: 'ts', ts: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  // Python
  python: 'py', py: 'py',
  // Shell
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  // Ruby
  ruby: 'rb', rb: 'rb',
  // Rust
  rust: 'rs', rs: 'rs',
  // Go
  go: 'go', golang: 'go',
  // JVM
  java: 'java',
  kotlin: 'kt', kt: 'kt',
  scala: 'scala',
  groovy: 'groovy',
  // C-family
  c: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  csharp: 'cs', cs: 'cs', 'c#': 'cs',
  objectivec: 'm', 'objective-c': 'm', objc: 'm',
  // Apple
  swift: 'swift',
  // Web
  php: 'php',
  html: 'html', xml: 'xml', svg: 'svg',
  css: 'css',
  scss: 'scss', sass: 'sass',
  less: 'less',
  // Data
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  csv: 'csv',
  // SQL
  sql: 'sql',
  // Markdown / docs
  markdown: 'md', md: 'md',
  rst: 'rst',
  asciidoc: 'adoc', adoc: 'adoc',
  // TeX
  latex: 'tex', tex: 'tex',
  bibtex: 'bib',
  // R / data-sci
  r: 'r',
  julia: 'jl',
  matlab: 'm',
  // Functional
  haskell: 'hs', hs: 'hs',
  elixir: 'ex', ex: 'ex',
  erlang: 'erl', erl: 'erl',
  clojure: 'clj', clj: 'clj',
  fsharp: 'fs', fs: 'fs', 'f#': 'fs',
  ocaml: 'ml', ml: 'ml',
  elm: 'elm',
  // Niche but on the gist
  nim: 'nim',
  crystal: 'cr', cr: 'cr',
  dart: 'dart',
  lua: 'lua',
  perl: 'pl', pl: 'pl',
  // Build / config
  dockerfile: 'Dockerfile', docker: 'Dockerfile',
  makefile: 'mk', make: 'mk',
  cmake: 'cmake',
  // Misc useful
  diff: 'diff', patch: 'diff',
  vim: 'vim', viml: 'vim',
  powershell: 'ps1', ps: 'ps1',
  protobuf: 'proto', proto: 'proto',
  graphql: 'graphql', gql: 'graphql',
  // Web manifests / configs that Discord highlights
  hcl: 'hcl', terraform: 'tf', tf: 'tf',
  nginx: 'conf', apache: 'conf',
}

export function langToExt(lang: string): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  return LANG_TO_EXT[key] ?? null
}
