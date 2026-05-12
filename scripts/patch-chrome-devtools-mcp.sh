#!/usr/bin/env bash
# Idempotent patch for chrome-devtools-mcp's "selected page has been closed"
# stuck state. The MCP server's list_pages and select_page handlers both call
# response.setListThirdPartyDeveloperTools() / setListWebMcpTools(), whose
# response-build pipeline (McpResponse.js) requires a live selected page to
# enumerate dev-tools and webmcp groups. When the selected page dies (most
# commonly: an OAuth popup closes), those enrichment calls throw and the
# RESPONSE itself fails — even for read-only / re-select operations that
# shouldn't depend on the selection at all.
#
# Fix: wrap the two getSelectedMcpPage() fallback blocks in try/catch so the
# enrichment fails silently and the underlying list/select still returns.
#
# Run this at clive launch (e.g. add a line to ~/tools/launch-chrome-debug.sh
# or any pre-clive shell hook):
#
#     ~/workspace/claude-plugins-official/scripts/patch-chrome-devtools-mcp.sh
#
# Idempotent: a sentinel comment is inserted; re-runs detect it and exit 0.
# Version-aware: warns if the installed chrome-devtools-mcp version drifts
# beyond the tested set so the patch doesn't silently apply to changed code.
#
# Retire this patch when the upstream PR lands and an upgrade pulls the fix.

set -euo pipefail

SENTINEL='/* patched-cdtmcp: skip enrichment when no valid selection */'
TESTED_VERSIONS_REGEX='^0\.(25|26)\.'

shopt -s nullglob
matches=( "$HOME/.npm/_npx/"*"/node_modules/chrome-devtools-mcp/build/src/McpResponse.js" )

if [ ${#matches[@]} -eq 0 ]; then
    echo "[patch-cdtmcp] no chrome-devtools-mcp install found under ~/.npm/_npx/*; nothing to patch" >&2
    exit 0
fi

for FILE in "${matches[@]}"; do
    INSTALL_ROOT="${FILE%/build/src/McpResponse.js}"
    PKG_JSON="$INSTALL_ROOT/package.json"
    if [ ! -f "$PKG_JSON" ]; then
        echo "[patch-cdtmcp] skipping (no package.json next to McpResponse.js): $FILE" >&2
        continue
    fi
    VERSION=$(jq -r '.version' "$PKG_JSON" 2>/dev/null || echo "?")

    if grep -qF "$SENTINEL" "$FILE"; then
        echo "[patch-cdtmcp] already patched (v$VERSION): $FILE" >&2
        continue
    fi

    if ! [[ "$VERSION" =~ $TESTED_VERSIONS_REGEX ]]; then
        echo "[patch-cdtmcp] WARNING: chrome-devtools-mcp v$VERSION is outside the tested set (0.25.x / 0.26.x)." >&2
        echo "[patch-cdtmcp] WARNING: skipping to avoid touching unverified code. Audit lines around 'getSelectedMcpPage' in McpResponse.js" >&2
        echo "[patch-cdtmcp] WARNING: and either widen TESTED_VERSIONS_REGEX or update the patch payload in $0." >&2
        continue
    fi

    python3 - "$FILE" <<'PY'
import sys

fn = sys.argv[1]
src = open(fn, 'r').read()

SENTINEL = '/* patched-cdtmcp: skip enrichment when no valid selection */'

OLD_TPDT = """        if (this.#listThirdPartyDeveloperTools) {
            const page = this.#page ?? context.getSelectedMcpPage();
            thirdPartyDeveloperTools = await getToolGroup(page);
            page.thirdPartyDeveloperTools = thirdPartyDeveloperTools;
        }"""
NEW_TPDT = """        if (this.#listThirdPartyDeveloperTools) {
            try { """ + SENTINEL + """
                const page = this.#page ?? context.getSelectedMcpPage();
                thirdPartyDeveloperTools = await getToolGroup(page);
                page.thirdPartyDeveloperTools = thirdPartyDeveloperTools;
            } catch { /* selected page invalid — skip dev-tools enrichment */ }
        }"""

OLD_WMCP = """        if (this.#listWebMcpTools && this.#args.categoryExperimentalWebmcp) {
            const page = this.#page ?? context.getSelectedMcpPage();
            webmcpTools = page.getWebMcpTools();
        }"""
NEW_WMCP = """        if (this.#listWebMcpTools && this.#args.categoryExperimentalWebmcp) {
            try {
                const page = this.#page ?? context.getSelectedMcpPage();
                webmcpTools = page.getWebMcpTools();
            } catch { /* selected page invalid — skip webmcp enrichment */ }
        }"""

n1 = src.count(OLD_TPDT)
n2 = src.count(OLD_WMCP)
if n1 != 1 or n2 != 1:
    print(f"[patch-cdtmcp] FAILED: expected exactly 1 match per block, got tpdt={n1} wmcp={n2}", file=sys.stderr)
    print("[patch-cdtmcp]   upstream code may have shifted; manual audit required.", file=sys.stderr)
    sys.exit(1)

src = src.replace(OLD_TPDT, NEW_TPDT, 1).replace(OLD_WMCP, NEW_WMCP, 1)
open(fn, 'w').write(src)
print(f"[patch-cdtmcp] applied (2 blocks wrapped): {fn}", file=sys.stderr)
PY
    echo "[patch-cdtmcp] patched v$VERSION at $FILE" >&2
done
