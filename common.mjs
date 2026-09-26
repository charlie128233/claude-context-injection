// Shared by the proxy and the MCP server: paths, settings, log.
// Node only, no dependencies.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
// State and log live outside the program folder, so they survive updates.
export const HOME = process.env.CONTEXT_INJECTION_HOME || join(homedir(), '.claude-context-injection');
export const ORIGINALS = join(HOME, 'originals'); // hidden results, for recall_context
export const RESTORE = join(HOME, 'restore');     // requests to put a result back in place
export const SESSIONS = join(HOME, 'sessions');   // decisions per conversation
export const LOG = join(HOME, 'proxy.log');
export const STATE = join(HOME, 'proxy.json');    // pid and port of the running proxy

export const DEFAULTS = {
  port: 8484,
  // where Claude Code's requests really go
  upstream: 'https://api.anthropic.com',
  // Any Jev-compatible endpoint: TypeSafe's Jev, or a self-hosted classifier
  // that speaks the same API ({state, questions} -> {answers: {name: {noul}}}).
  classifierUrl: 'https://api.typesafe.ai/v1/systemone',
  classifierModel: 'jev-latest',
  // The key: from an environment variable (recommended) or from a file.
  classifierKeyEnv: 'TYPESAFE_API_KEY',
  classifierKeyFile: '',
  classifierTimeoutSeconds: 20,
  enabled: true,
  // Only hide when the conversation is big: below this, hiding buys nothing
  // and costs a prompt-cache miss.
  hideFromTokens: 60000,
  hideThreshold: 0.4,
  restoreThreshold: 0.6,
  minChars: 2000,
  sampleChars: 400,
  stateTokens: 10000,
  // never hidden: subagent reports, edits, todos (and failed calls, always)
  neverTouch: ['Task', 'Agent', 'TodoWrite', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
};

export function settings() {
  const s = { ...DEFAULTS };
  for (const f of [join(HERE, 'settings.json'), join(HOME, 'settings.json')]) {
    try {
      Object.assign(s, JSON.parse(readFileSync(f, 'utf8')));
    } catch { /* missing or unreadable: defaults apply */ }
  }
  if (process.env.CONTEXT_INJECTION_PORT) s.port = Number(process.env.CONTEXT_INJECTION_PORT);
  if (process.env.CONTEXT_INJECTION_UPSTREAM) s.upstream = process.env.CONTEXT_INJECTION_UPSTREAM;
  if (process.env.CONTEXT_INJECTION_CLASSIFIER) s.classifierUrl = process.env.CONTEXT_INJECTION_CLASSIFIER;
  return s;
}

export function apiKey(s) {
  if (s.classifierKeyEnv && process.env[s.classifierKeyEnv]) return process.env[s.classifierKeyEnv].trim();
  if (s.classifierKeyFile) {
    try { return readFileSync(s.classifierKeyFile, 'utf8').trim(); } catch { /* none */ }
  }
  return '';
}

export function prepare() {
  for (const d of [HOME, ORIGINALS, RESTORE, SESSIONS]) mkdirSync(d, { recursive: true });
}

export function log(text) {
  try {
    mkdirSync(HOME, { recursive: true });
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    appendFileSync(LOG, `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}  ${text}\n`);
  } catch { /* a log that cannot be written must never stop anything */ }
}

export function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, p);
}

/** A tool_use id as a safe file name. */
export function fileName(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
