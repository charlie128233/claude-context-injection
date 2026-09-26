// Tests the proxy without Claude Code and without network: a fake Anthropic
// server records what it receives, a fake classifier answers predictably
// (relevant = file named in the request), and requests are built the way
// Claude Code sends them (the whole conversation every time).
//   node test/proxy.test.mjs      (or: npm test)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'context-injection-test-'));
process.env.CONTEXT_INJECTION_HOME = home;
const { start, NOTE } = await import('../proxy.mjs');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failed = 0;
const check = (cond, text) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${text}`); if (!cond) failed++; };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// --- fake Anthropic API -------------------------------------------------------------
const received = [];
const anthropic = createServer((req, res) => {
  let c = '';
  req.on('data', (x) => { c += x; });
  req.on('end', () => {
    let body = {};
    try { body = c ? JSON.parse(c) : {}; } catch { body = { raw: c }; }
    received.push({ url: req.url, body, auth: req.headers['x-api-key'] || req.headers.authorization });
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":123}'); return; }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => { res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n'); res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }, 50);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message","content":[{"type":"text","text":"ok"}]}');
    }
  });
});
// --- fake classifier (Jev API) ---------------------------------------------------------------
let questionsReceived = 0;
let classifierDown = false;
const classifier = createServer((req, res) => {
  let c = '';
  req.on('data', (x) => { c += x; });
  req.on('end', () => {
    if (classifierDown) { res.writeHead(503); res.end('down'); return; }
    const { state, questions } = JSON.parse(c);
    const files = new Map();
    for (const e of state.history || []) for (const t of e.tool_calls || []) if (t && typeof t === 'object') {
      try { files.set(t.id, JSON.parse(t.input).file_path); } catch { /* truncated */ }
    }
    const answers = {};
    for (const q of Object.keys(questions)) {
      questionsReceived++;
      const f = files.get(q.replace('rel_', '')) || '?';
      answers[q] = { noul: String(state.goal).includes(f) ? 0.95 : 0.1 };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers }));
  });
});
const portA = await listen(anthropic);
const portC = await listen(classifier);
const s = {
  port: 0, upstream: `http://127.0.0.1:${portA}`, classifierUrl: `http://127.0.0.1:${portC}/v1/systemone`, classifierModel: 'jev-latest',
  classifierKeyEnv: 'X', classifierKeyFile: '', classifierTimeoutSeconds: 5, enabled: true,
  hideFromTokens: 1000, hideThreshold: 0.4, restoreThreshold: 0.6, minChars: 500, sampleChars: 200, stateTokens: 10000,
  neverTouch: ['Task', 'Edit', 'Write', 'TodoWrite'],
};
const proxy = start(s);
const portP = await listen(proxy);
process.env.CONTEXT_INJECTION_PORT = String(portP);

// --- a Claude Code style conversation -----------------------------------------------------------
const FILES = ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py'];
const content = (f) => `# ${f}\n` + `def function_${f[0]}(x):\n    return x * 2  # test line for ${f}\n`.repeat(30);
const msgs = [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>reminder</system-reminder>' }, { type: 'text', text: 'Read all the .py files' }] }];
FILES.forEach((f, i) => {
  msgs.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking', signature: 'sig' }, { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: f } }] });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: [{ type: 'text', text: content(f) }], cache_control: i === 5 ? { type: 'ephemeral' } : undefined }] });
});
msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'Read them.' }] });
// a failed call: never hidden
msgs.push({ role: 'user', content: [{ type: 'text', text: 'ok' }] });
msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'x' } }] });
msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_err', is_error: true, content: 'error '.repeat(200) }] });
msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'Error.' }] });

async function send(messages, { stream = false, url = '/v1/messages' } = {}) {
  const r = await fetch(`http://127.0.0.1:${portP}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fake-key' },
    body: JSON.stringify({ model: 'claude', stream, metadata: { user_id: 'user_x_account_y_session_1234abcd-0000' }, messages }),
  });
  const text = await r.text();
  return { status: r.status, text, got: received.at(-1) };
}
const states = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])
  .filter((b) => b.type === 'tool_result').map((b) => {
    const t = b.content.map ? b.content.map((x) => x.text).join('') : String(b.content);
    return `${b.tool_use_id}:${t.includes(NOTE) ? 'hidden' : 'full'}`;
  }));

console.log('1. new request about b.py: the others are hidden');
const conv1 = [...msgs, { role: 'user', content: [{ type: 'text', text: 'Let us talk only about b.py: what does it do?' }] }];
let r = await send(conv1, { stream: true });
let st = states(r.got.body);
check(st.includes('toolu_1:full'), 'b.py stays in full');
check(['toolu_0', 'toolu_2', 'toolu_3', 'toolu_4', 'toolu_5'].every((id) => st.includes(`${id}:hidden`)), 'a, c, d, e, f hidden');
check(st.includes('toolu_err:full'), 'the failed call is never touched');
check(r.text.includes('message_stop') && r.text.includes('hello'), 'streaming passes through intact');
check(r.got.auth === 'fake-key', 'credentials pass through');
check(r.got.body.messages[1].content[0].type === 'thinking' && r.got.body.messages[1].content[0].signature === 'sig', 'thinking blocks untouched');
check(JSON.stringify(r.got.body.messages[12].content[0].cache_control) === '{"type":"ephemeral"}', 'cache_control stays on the block');
check(conv1[2].content[0].content[0].text.startsWith('# a.py'), "Claude Code's conversation is not modified");
const questionsAfter1 = questionsReceived;

console.log('2. same turn (new results): decisions frozen, classifier not called again');
const conv2 = [...conv1, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { pattern: 'x' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_g', content: 'line '.repeat(300) }] }];
r = await send(conv2);
st = states(r.got.body);
check(questionsReceived === questionsAfter1, 'no new questions to the classifier');
check(st.includes('toolu_0:hidden') && st.includes('toolu_g:full'), 'same decisions, current turn result in full');

console.log('3. count_tokens: same projection, no judging');
r = await send(conv2, { url: '/v1/messages/count_tokens' });
check(states(r.got.body).includes('toolu_0:hidden') && questionsReceived === questionsAfter1, 'projection applied, classifier not called');

console.log('4. new request about e.py: e restored, b hidden (hysteresis)');
const conv3 = [...conv2, { role: 'assistant', content: [{ type: 'text', text: 'b doubles.' }] }, { role: 'user', content: 'And what about e.py?' }];
r = await send(conv3);
st = states(r.got.body);
check(st.includes('toolu_4:full'), 'e.py put back in place');
check(st.includes('toolu_1:hidden'), 'b.py now hidden');

console.log('5. recall_context from the MCP server: d.py back in place, not duplicated');
const mcp = spawn(process.execPath, [join(ROOT, 'recall-mcp.mjs')], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = [];
mcp.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => replies.push(JSON.parse(l))));
const ask = (m) => mcp.stdin.write(`${JSON.stringify(m)}\n`);
ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
ask({ jsonrpc: '2.0', method: 'notifications/initialized' });
ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall_context', arguments: { id: 'toolu_3' } } });
ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'recall_context', arguments: { id: 'toolu_missing' } } });
await new Promise((ok) => setTimeout(ok, 1500));
mcp.kill();
check(replies.find((x) => x.id === 1)?.result?.serverInfo?.name === 'context-injection', 'MCP: initialize');
check(replies.find((x) => x.id === 2)?.result?.tools?.[0]?.name === 'recall_context', 'MCP: tools/list');
check(/Put back in place/.test(replies.find((x) => x.id === 3)?.result?.content?.[0]?.text || ''), 'MCP: recall_context asks to put it back');
check(replies.find((x) => x.id === 4)?.result?.isError === true, 'MCP: unknown id -> clear error');
const conv4 = [...conv3, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'mcp__context-injection__recall_context', input: { id: 'toolu_3' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: 'Put back in place' }] }];
r = await send(conv4);
check(states(r.got.body).includes('toolu_3:full'), 'd.py in full, in place, on the next request');

console.log('6. classifier down: previous decisions kept, Claude Code keeps working');
classifierDown = true;
const conv5 = [...conv4, { role: 'assistant', content: [{ type: 'text', text: 'here is d' }] }, { role: 'user', content: 'Back to a.py' }];
r = await send(conv5);
check(r.status === 200, 'status 200');
check(states(r.got.body).includes('toolu_1:hidden'), 'previous decisions applied');

console.log('7. non-JSON request: forwarded unchanged');
const raw = await fetch(`http://127.0.0.1:${portP}/v1/messages`, { method: 'POST', body: 'not json' });
check(raw.status === 200 && received.at(-1).url === '/v1/messages', 'forwarded');

proxy.close(); anthropic.close(); classifier.close();
rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} CHECKS FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
