#!/usr/bin/env node
/**
 * claude-context-injection - a local proxy for Claude Code.
 *
 * Claude Code sends the WHOLE conversation with every request. This proxy
 * (ANTHROPIC_BASE_URL=http://127.0.0.1:8484) sits in between and decides
 * what the model sees of old tool results:
 *
 *   - on every NEW user request it asks a classifier (Jev, or any
 *     Jev-compatible endpoint) how relevant each old tool result is to that
 *     request. Below hideThreshold the result is hidden (a note with its id
 *     takes its place), above restoreThreshold a hidden result is put back in
 *     place, in between nothing changes (hysteresis);
 *   - within a turn decisions are frozen: the prompt cache breaks at most
 *     once per user request;
 *   - Claude Code's own transcript is never touched: hiding and restoring are
 *     just a projection of the outgoing request. Nothing is lost;
 *   - the recall_context MCP tool (recall-mcp.mjs) asks the proxy to put a
 *     result back IN PLACE, without duplicating it.
 *
 * If anything goes wrong (classifier down, odd request), the request is
 * forwarded unchanged: the proxy must never stop Claude Code.
 *
 *   node proxy.mjs            in the foreground
 *   node proxy.mjs --ensure   start it in the background unless already up
 *   node proxy.mjs --stop     stop it
 *   node proxy.mjs --status   is it up? with which settings?
 */
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JevClient, collectToolCalls, fitState, noulAnswer, resolveOptions,
} from './vendor/fast-jev-compaction/index.js';
import {
  HOME, LOG, ORIGINALS, RESTORE, SESSIONS, STATE, apiKey, fileName, log, prepare, readJson, settings, writeJson,
} from './common.mjs';

export const NOTE = '[context-injection:';
export const RECALL_TOOL = 'mcp__context-injection__recall_context';
const CONTEXT = 'A coding assistant conversation (Claude Code). `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note (with a sample of their content) and long texts may be abridged. The user has just sent a NEW request, given in `goal`. Each question asks whether the output of one earlier tool call is relevant to that new request. Outputs judged not relevant are hidden for now and can be shown again later; nothing is deleted.';

// --- reading the conversation -------------------------------------------------------

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(content) {
  return blocks(content).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'document' ? '[document]' : ''))
    .filter(Boolean).join('\n');
}

/** What the person typed, without the reminders Claude Code adds. */
function clean(t) {
  return String(t).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** A message typed by the user (not a round of tool results). */
function isUserRequest(m) {
  if (!m || m.role !== 'user') return false;
  const b = blocks(m.content);
  return !b.some((x) => x.type === 'tool_result') && clean(textOf(b)).length > 0;
}

function conversationKey(body) {
  const uid = (body.metadata && body.metadata.user_id) || '';
  const session = (/session_([0-9a-f-]{8,})/i.exec(uid) || [])[1] || uid;
  // the first message tells the main conversation apart from subagents
  const first = body.messages && body.messages[0] ? JSON.stringify(body.messages[0].content).slice(0, 4000) : '';
  return createHash('sha1').update(`${session}|${first}`).digest('hex').slice(0, 16);
}

function hash(t) {
  return createHash('sha1').update(t).digest('hex').slice(0, 12);
}

/** Every tool result, with the call that produced it. */
function toolResults(messages) {
  const calls = new Map();
  messages.forEach((m) => {
    if (m.role !== 'assistant') return;
    for (const b of blocks(m.content)) if (b.type === 'tool_use') calls.set(b.id, { tool: b.name, input: b.input });
  });
  const out = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user') return;
    blocks(m.content).forEach((b, j) => {
      if (b.type !== 'tool_result') return;
      const c = calls.get(b.tool_use_id) || { tool: '?', input: {} };
      out.push({ id: b.tool_use_id, msg: i, block: j, tool: c.tool, input: c.input, text: textOf(b.content), error: b.is_error === true });
    });
  });
  return out;
}

/** Messages in the shape used by the fast-jev-compaction library. */
function forLibrary(messages) {
  return messages.map((m) => {
    const b = blocks(m.content);
    return {
      role: m.role,
      text: clean(b.filter((x) => x.type === 'text').map((x) => x.text).join('\n')),
      toolUses: b.filter((x) => x.type === 'tool_use').map((x) => ({ tool_use_id: x.id, tool: x.name, input: x.input && typeof x.input === 'object' ? x.input : {} })),
      toolResults: b.filter((x) => x.type === 'tool_result').map((x) => ({ tool_use_id: x.tool_use_id, text: textOf(x.content), isError: x.is_error === true })),
    };
  });
}

function estimateTokens(messages) {
  return Math.round(JSON.stringify(messages).length / 3.5);
}

// --- judging, on every new user request -----------------------------------------------

async function judge(body, last, results, hidden, s, conv) {
  const tokens = estimateTokens(body.messages);
  const mayHide = tokens >= s.hideFromTokens;
  const never = new Set([...(s.neverTouch || []), RECALL_TOOL]);
  const candidates = results.filter((r) => r.msg < last && !r.error && !never.has(r.tool) && r.text.length >= s.minChars);
  if (!candidates.length || (!mayHide && !candidates.some((r) => hidden.has(r.id)))) return null;

  const lib = forLibrary(body.messages);
  const pinned = lib.length - last;
  const calls = collectToolCalls(lib, pinned);
  const byId = new Map(calls.map((c) => [c.tool_use_id, c]));
  const options = resolveOptions({ goal: clean(textOf(body.messages[last].content)).slice(0, 2000), preserveRecentMessages: pinned, maxStateTokens: s.stateTokens, maxRequestTokens: 1e9 });
  const fitted = fitState(lib, calls, options);
  fitted.state.context = CONTEXT;
  // A sample of the content for each candidate: with "(omitted)" only, the
  // classifier can do little better than a fixed rule (fast-jev-compaction #26, #99).
  const sample = new Map();
  for (const r of candidates) {
    const c = byId.get(r.id);
    if (!c) continue;
    const t = r.text.replace(/\s+/g, ' ').trim();
    const head = Math.ceil(s.sampleChars * 0.6);
    const tail = s.sampleChars - head;
    sample.set(c.id, t.length <= head + tail + 20 ? t : `${t.slice(0, head)} [...] ${t.slice(-tail)}`);
  }
  for (const entry of fitted.state.history || []) {
    for (const c of entry.tool_calls || []) {
      if (c && typeof c === 'object' && sample.has(c.id)) c.result = `${c.result}; sample: ${sample.get(c.id)}`;
    }
  }
  const questions = {};
  for (const r of candidates) {
    const c = byId.get(r.id);
    if (!c) continue;
    questions[`rel_${c.id}`] = {
      type: 'noul',
      instructions: `The output of tool call ${c.id} (${c.tool}, ${r.text.length} chars) is relevant to the user's new request in \`goal\`: to answer it, the assistant will likely need what that output contains`,
    };
  }
  const t0 = Date.now();
  const client = new JevClient({
    apiKey: apiKey(s) || 'none', baseUrl: s.classifierUrl, model: s.classifierModel,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(s.classifierTimeoutSeconds * 1000) }),
  });
  const { answers } = await client.ask(fitted.state, questions);
  const next = new Set(hidden);
  let hiddenNow = 0;
  let restoredNow = 0;
  for (const r of candidates) {
    const c = byId.get(r.id);
    if (!c) continue;
    const p = noulAnswer(answers, `rel_${c.id}`);
    if (hidden.has(r.id) && p > s.restoreThreshold) {
      next.delete(r.id);
      restoredNow++;
    } else if (!hidden.has(r.id) && mayHide && p < s.hideThreshold) {
      next.add(r.id);
      hiddenNow++;
      writeJson(join(ORIGINALS, `${fileName(r.id)}.json`), { id: r.id, tool: r.tool, input: r.input, text: r.text, conversation: conv });
    }
  }
  log(`conv ${conv.slice(0, 8)}  new request: ${candidates.length} old results judged, ${hiddenNow} hidden, ${restoredNow} restored, ` +
    `${next.size} hidden in total, ~${tokens} tokens  classifier ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return next;
}

// --- projecting one request ---------------------------------------------------------------

/** Requests from recall_context: ids to put back in place. */
function toRestore() {
  const ids = new Set();
  let names = [];
  try { names = readdirSync(RESTORE); } catch { return ids; }
  for (const n of names) {
    const p = join(RESTORE, n);
    try {
      if (Date.now() - statSync(p).mtimeMs > 3600 * 1000) { unlinkSync(p); continue; }
    } catch { continue; }
    ids.add(n);
  }
  return ids;
}

/**
 * Returns { body, changed }. Never throws on the happy path; when in doubt,
 * the caller forwards the request unchanged.
 */
export async function project(body, s, { judging = true } = {}) {
  if (!s.enabled || !body || !Array.isArray(body.messages) || !body.messages.length) return { body, changed: 0 };
  const conv = conversationKey(body);
  const file = join(SESSIONS, `${conv}.json`);
  const st = readJson(file, { hidden: [], turn: '' });
  let hidden = new Set(st.hidden || []);
  let dirty = false;

  const restore = toRestore();
  for (const id of [...hidden]) {
    if (restore.has(fileName(id))) {
      hidden.delete(id);
      dirty = true;
      log(`conv ${conv.slice(0, 8)}  put back in place on request (recall_context): ${id}`);
    }
  }

  let last = -1;
  for (let i = body.messages.length - 1; i >= 0; i--) if (isUserRequest(body.messages[i])) { last = i; break; }
  const results = toolResults(body.messages);
  const turn = last >= 0 ? `${last}:${hash(textOf(body.messages[last].content))}` : '';
  if (judging && turn && turn !== st.turn) {
    try {
      const next = await judge(body, last, results, hidden, s, conv);
      if (next) hidden = next;
    } catch (err) {
      log(`conv ${conv.slice(0, 8)}  classifier unavailable (${err && err.message}), keeping previous decisions`);
    }
    st.turn = turn;
    dirty = true;
  }
  if (dirty) writeJson(file, { hidden: [...hidden], turn: st.turn, updated: new Date().toISOString() });
  if (!hidden.size) return { body, changed: 0 };

  // copy only what changes: everything else stays the same object
  const messages = body.messages.slice();
  let changed = 0;
  for (const r of results) {
    if (!hidden.has(r.id) || r.msg >= last) continue;
    const m = messages[r.msg];
    const b = blocks(m.content).slice();
    const old = b[r.block];
    b[r.block] = {
      ...old,
      content: [{ type: 'text', text: `${NOTE} the output of this ${r.tool} call (${r.text.length} chars) is hidden because it does not seem relevant to the current request; id ${r.id}. If you need it, call the recall_context tool with this id: it will be put back here, in place]` }],
    };
    messages[r.msg] = { ...m, content: b };
    changed++;
  }
  return { body: { ...body, messages }, changed };
}

// --- the server --------------------------------------------------------------------------------

const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade']);

function forward(req, res, payload, s) {
  const url = new URL(req.url, s.upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  headers['content-length'] = String(payload.length);
  const mod = url.protocol === 'http:' ? http : https;
  const up = mod.request({ method: req.method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers }, (resp) => {
    if (process.env.CONTEXT_INJECTION_DEBUG) log(`debug ${req.method} ${req.url} -> ${resp.statusCode} (${payload.length} bytes sent)`);
    const h = { ...resp.headers };
    delete h.connection;
    res.writeHead(resp.statusCode || 502, h);
    resp.pipe(res);
  });
  up.on('error', (err) => {
    log(`ERROR reaching ${s.upstream}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `claude-context-injection: ${s.upstream} unreachable (${err.message})` } }));
    } else {
      res.destroy();
    }
  });
  req.on('aborted', () => up.destroy());
  up.end(payload);
}

export function start(s = settings()) {
  prepare();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, port: s.port, upstream: s.upstream, classifier: s.classifierUrl, key: apiKey(s) ? 'yes' : 'no' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let payload = Buffer.concat(chunks);
      if (req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url)) {
        try {
          const body = JSON.parse(payload.toString('utf8'));
          const { body: projected, changed } = await project(body, s, { judging: !req.url.includes('count_tokens') });
          if (changed) payload = Buffer.from(JSON.stringify(projected), 'utf8');
        } catch (err) {
          log(`ERROR while projecting, forwarding the request unchanged: ${err && err.message}`);
        }
      }
      forward(req, res, payload, s);
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  return server;
}

// --- command line -------------------------------------------------------------------------------

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const s = settings();
  const arg = process.argv[2] || '';
  if (arg === '--status') {
    const h = await health(s.port);
    console.log(h ? `running: ${JSON.stringify(h)}` : `not running (port ${s.port})`);
    console.log(`log: ${LOG}`);
    process.exit(h ? 0 : 1);
  }
  if (arg === '--stop') {
    const h = await health(s.port);
    if (!h) { console.log('not running'); return; }
    try { process.kill(h.pid); console.log(`stopped (pid ${h.pid})`); } catch (e) { console.log(`cannot stop it: ${e.message}`); process.exit(1); }
    return;
  }
  if (arg === '--ensure') {
    if (await health(s.port)) process.exit(0);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await health(s.port)) process.exit(0);
    }
    console.error(`the proxy does not answer on port ${s.port}: see ${LOG}`);
    process.exit(1);
  }
  const server = start(s);
  server.on('error', (e) => { log(`ERROR: the proxy cannot start on port ${s.port}: ${e.message}`); console.error(e.message); process.exit(1); });
  server.listen(s.port, '127.0.0.1', () => {
    writeJson(STATE, { pid: process.pid, port: s.port, started: new Date().toISOString() });
    log(`proxy on 127.0.0.1:${s.port} -> ${s.upstream}, classifier ${s.classifierUrl} (key ${apiKey(s) ? 'present' : 'MISSING: nothing will be hidden'}); state in ${HOME}`);
    console.log(`claude-context-injection: proxy on http://127.0.0.1:${s.port}`);
  });
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  main();
}
