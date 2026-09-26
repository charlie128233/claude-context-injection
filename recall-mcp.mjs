#!/usr/bin/env node
/**
 * recall-mcp.mjs - MCP server (stdio) with the recall_context tool.
 *
 * When the proxy hides an old tool result, a note with its id takes its
 * place. The model calls recall_context(id) and:
 *   - if the proxy is running, the result is PUT BACK IN PLACE in the
 *     conversation (from the next request on), not duplicated here;
 *   - if the proxy is not running, the original content is returned here.
 *
 * Protocol: JSON-RPC 2.0, one message per line (MCP stdio transport).
 * Node only, no dependencies.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ORIGINALS, RESTORE, fileName, log, prepare, readJson, settings } from './common.mjs';

const TOOL = {
  name: 'recall_context',
  description: 'Puts back the full output of an earlier tool call that was hidden to keep the context small and relevant. ' +
    'Hidden outputs are replaced by a note like "[context-injection: ... id toolu_... ...]": pass that id. ' +
    'Use it instead of re-running the tool when you need the old output exactly as it was.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'the id written in the note (starts with toolu_)' } },
    required: ['id'],
  },
};

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function proxyRunning(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function recall(id) {
  const orig = readJson(join(ORIGINALS, `${fileName(id)}.json`));
  if (!orig) {
    return { isError: true, content: [{ type: 'text', text: `No hidden result with id ${id}: check the id in the note, or re-run the tool.` }] };
  }
  if (await proxyRunning(settings().port)) {
    writeFileSync(join(RESTORE, fileName(id)), new Date().toISOString());
    log(`recall_context ${id}: asked the proxy to put it back in place (${orig.text.length} chars)`);
    return { content: [{ type: 'text', text: `Put back in place: the output of the ${orig.tool} call with id ${id} (${orig.text.length} chars) is visible again, in full, where it was, from the next request on. Not repeated here to avoid duplicating it.` }] };
  }
  log(`recall_context ${id}: proxy not running, returning the original (${orig.text.length} chars)`);
  return { content: [{ type: 'text', text: orig.text }] };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'context-injection', version: '0.1.0' } };
  }
  if (method === 'tools/list') return { tools: [TOOL] };
  if (method === 'tools/call') {
    if (!params || params.name !== TOOL.name) throw { code: -32602, message: `unknown tool: ${params && params.name}` };
    return recall(String((params.arguments || {}).id || ''));
  }
  if (method === 'ping') return {};
  if (id === undefined) return undefined; // notification
  throw { code: -32601, message: `method not supported: ${method}` };
}

prepare();
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }); return; }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } });
  }
});
