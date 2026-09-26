#!/usr/bin/env bash
# Claude Code with context injection, for THIS terminal only.
#   1. starts the local proxy (127.0.0.1:8484) unless it is already running
#   2. runs claude with ANTHROPIC_BASE_URL pointing at the proxy and the
#      recall_context MCP server
# Claude Code's own settings are not changed. Arguments go to claude,
# e.g.  ./claude-injection.sh --continue
# The classifier key comes from the environment (TYPESAFE_API_KEY by default,
# see settings.example.json). Without a key nothing is hidden: the proxy just
# forwards everything and Claude Code works as usual.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude not found" >&2; exit 1; }
node "$HERE/proxy.mjs" --ensure
PORT="${CONTEXT_INJECTION_PORT:-8484}"
MCP="$(mktemp -t context-injection-mcp.XXXXXX.json)"
printf '{"mcpServers":{"context-injection":{"command":"node","args":["%s/recall-mcp.mjs"]}}}\n' "$HERE" > "$MCP"
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
echo "Claude Code with context injection (proxy $ANTHROPIC_BASE_URL)"
exec claude --mcp-config "$MCP" "$@"
