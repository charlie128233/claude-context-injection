@echo off
setlocal
REM ---------------------------------------------------------------------
REM  Claude Code with context injection, for THIS window only.
REM
REM  1. starts the local proxy (127.0.0.1:8484) unless it is already running
REM  2. runs claude with ANTHROPIC_BASE_URL pointing at the proxy and the
REM     recall_context MCP server
REM
REM  Claude Code's own settings are not changed: other windows and the
REM  desktop app do not go through the proxy. Arguments go to claude,
REM  e.g.  claude-injection.cmd --continue
REM
REM  The classifier key comes from the environment (TYPESAFE_API_KEY by
REM  default, see settings.example.json). Without a key nothing is hidden:
REM  the proxy just forwards everything and Claude Code works as usual.
REM  Log: %USERPROFILE%\.claude-context-injection\proxy.log
REM ---------------------------------------------------------------------
set "HERE=%~dp0"

where node >nul 2>&1 || (echo  ERROR: node not found. & pause & exit /b 1)
where claude >nul 2>&1 || (echo  ERROR: claude not found. & pause & exit /b 1)

node "%HERE%proxy.mjs" --ensure
if errorlevel 1 (
    echo  ERROR: the proxy did not start. Log: %USERPROFILE%\.claude-context-injection\proxy.log
    pause
    exit /b 1
)

REM  MCP config with this folder's path (forward slashes for JSON)
set "P=%HERE:\=/%"
set "MCP=%TEMP%\context-injection-mcp.json"
> "%MCP%" echo {"mcpServers":{"context-injection":{"command":"node","args":["%P%recall-mcp.mjs"]}}}

if not defined CONTEXT_INJECTION_PORT set "CONTEXT_INJECTION_PORT=8484"
set "ANTHROPIC_BASE_URL=http://127.0.0.1:%CONTEXT_INJECTION_PORT%"
echo  Claude Code with context injection ^(proxy %ANTHROPIC_BASE_URL%^)
claude --mcp-config "%MCP%" %*
