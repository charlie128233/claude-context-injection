# claude-context-injection

**Reversible, per-request context injection for Claude Code.**

A local proxy sits between Claude Code and the Anthropic API. Every time
you send a new request, a small classifier judges which old tool results
are relevant to it: [Jev](https://typesafe.ai), or any model that speaks
Jev's API. Irrelevant results are hidden behind a one-line note. Hidden
results come back **in place** as soon as they become relevant again, and
the model can ask for any of them by id. Nothing is ever lost: Claude
Code's own transcript is never modified.

> Status: **experimental (v0.1)**. The mechanism is covered by an offline
> test suite (22 checks against a fake Anthropic API and a fake
> classifier). A sibling implementation of the same idea runs as a plugin
> for DeepSeek Harness on the author's server, with a real 27B model and a
> local classifier. It has **not yet been validated in a long live Claude
> Code session**. Reports are very welcome.

## Why

Long agent sessions fill the context with old tool output: files read an
hour ago, test logs, search results. The usual fixes are lossy:

- **compaction/summarisation** rewrites history and loses exact paths,
  errors and code;
- **clearing old tool results**, as Anthropic's `clear_tool_uses` does, goes
  by age, not relevance, and cleared content cannot come back;
- **[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)**
  (the inspiration for this project) asks Jev which tool results are still
  needed, but only at compaction time, and its drops are permanent.

What was missing, as far as I could find (see [RESEARCH.md](RESEARCH.md)),
is **per-request, reversible** selection. When you change topic, results
about the old topic step aside. When you come back to it, they come back,
in the same place, byte for byte.

## How it works

```
 Claude Code ──► proxy 127.0.0.1:8484 ──► api.anthropic.com
                   │  on every NEW user request:
                   │    classifier: "is the output of t3 relevant to this request?"
                   │    p < 0.4 → hidden (note with id), p > 0.6 → restored
                   └─ within a turn, decisions are frozen (prompt cache friendly)

 recall_context (MCP tool) ──► "put toolu_… back in place"
```

- **When it decides**: only on the first request of each new user turn.
  Within a turn decisions are frozen. The prompt cache therefore breaks at
  most once per user request, and only if something changed; the
  hysteresis between 0.4 and 0.6 keeps changes rare.
- **What it touches**: only the `content` of `tool_result` blocks from
  **previous** turns. It never touches signed `thinking` blocks, tool
  calls, or the current turn. Results of `Task`/`Agent`,
  `Edit`/`Write`/`MultiEdit`, `TodoWrite` and failed calls are never hidden.
- **When it hides**: only when the conversation is larger than
  `hideFromTokens` (60k by default). Below that, hiding saves nothing and
  costs a cache miss. Restoring is always allowed.
- **What the classifier sees**: a compact view of the conversation, built
  with fast-jev-compaction's own state builder, plus a head+tail **sample**
  of each candidate output. With outputs shown only as "(omitted)", Jev
  can do little better than a fixed rule
  ([#26](https://github.com/tamaratran/fast-jev-compaction/issues/26),
  [#99](https://github.com/tamaratran/fast-jev-compaction/issues/99)).
- **`recall_context(id)`**: an MCP tool the model can call when it needs a
  hidden result. While the proxy is running, the result is **put back in
  its original place** from the next request on, instead of being pasted
  again at the end, so it never counts twice. If the proxy is down, the
  tool returns the original text.
- **Fail-open**: if the classifier is unreachable, the key is missing, or a
  request can't be parsed, the request is forwarded unchanged and the
  previous decisions stay. The proxy must never stop Claude Code.

Why a proxy? Claude Code hooks can add context
(`additionalContext`) or rewrite a tool result as it arrives
(`updatedToolOutput`), but no hook can edit **earlier** messages. The
experimental function hooks can rewrite history only through a compaction,
which invalidates the cache and is undone by `--resume`. Claude Code sends
the whole conversation with every request, so a proxy can change the
outgoing copy and leave the transcript alone. That is the only fully
reversible option that works with any Claude Code version.

## Quick start

Requirements: Node ≥ 18.17, Claude Code, and a Jev-compatible classifier
endpoint.

```bash
git clone https://github.com/charlie128233/claude-context-injection
cd claude-context-injection
export TYPESAFE_API_KEY=...          # or configure another classifier, see below
./claude-injection.sh                # Windows: claude-injection.cmd
```

The launcher starts the proxy if it isn't running, then starts `claude`
with `ANTHROPIC_BASE_URL` pointing at it and the `recall_context` MCP
server. **Only that terminal goes through the proxy**: your Claude Code
settings are not changed. Any extra arguments are passed to `claude`, for
example `./claude-injection.sh --continue`.

Check that it's working:

```bash
node proxy.mjs --status
tail -f ~/.claude-context-injection/proxy.log
```

A line like this appears on each new request that changes something:

```
conv 3f2a91c0  new request: 14 old results judged, 5 hidden, 1 restored, 6 hidden in total, ~83412 tokens  classifier 1.2 s
```

### As a Claude Code plugin

```bash
claude plugin marketplace add charlie128233/claude-context-injection
claude plugin install claude-context-injection@claude-context-injection
```

The plugin brings the `recall_context` MCP server, and a `SessionStart`
hook that starts the proxy. You still have to point Claude Code at the
proxy, in `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8484" } }
```

⚠️ With this, **every** Claude Code session goes through the proxy, and if
the proxy isn't running Claude Code can't connect. The launcher is the
safer way to try it.

## Classifiers

Any endpoint that speaks Jev's API works: `POST {model, state, questions}`
with `noul` questions, answered as `{answers: {name: {noul: p}}}`.

| classifier | settings |
|---|---|
| **Jev** (TypeSafe, hosted) — default | `classifierUrl: https://api.typesafe.ai/v1/systemone`, `classifierModel: jev-latest`, key in `TYPESAFE_API_KEY` |
| **self-hosted** (e.g. [SemIf](https://github.com/TheoLeeCJ/SemIf), Qwen3.5-4B scoring options from logits) | `classifierUrl: http://<host>:<port>/<path>`, `classifierKeyEnv` or `classifierKeyFile` |

SemIf itself is a command-line tool. To use it here you need a small HTTP
wrapper that exposes the Jev API. The author runs one next to his agent
server; it is not part of this repository yet.

## Settings

`settings.json` next to `proxy.mjs`, or in `~/.claude-context-injection/`.
See `settings.example.json`.

| key | default | |
|---|---|---|
| `port` | 8484 | proxy port (listens on 127.0.0.1 only) |
| `upstream` | `https://api.anthropic.com` | where requests really go |
| `classifierUrl` / `classifierModel` | Jev | see above |
| `classifierKeyEnv` / `classifierKeyFile` | `TYPESAFE_API_KEY` / — | where to read the classifier key |
| `hideFromTokens` | 60000 | never hide below this conversation size |
| `hideThreshold` / `restoreThreshold` | 0.4 / 0.6 | hysteresis |
| `minChars` | 2000 | smaller results are never touched |
| `sampleChars` | 400 | head+tail sample shown to the classifier per result |
| `neverTouch` | Task, Agent, TodoWrite, Edit, MultiEdit, Write, NotebookEdit | tools whose results are never hidden |
| `enabled` | true | `false` = pure pass-through |

Environment overrides: `CONTEXT_INJECTION_PORT`, `CONTEXT_INJECTION_UPSTREAM`,
`CONTEXT_INJECTION_CLASSIFIER`, `CONTEXT_INJECTION_HOME`, and
`CONTEXT_INJECTION_DEBUG=1`, which logs every forwarded request.

State lives in `~/.claude-context-injection/`:
- `proxy.log`: the log;
- `sessions/`: decisions per conversation;
- `originals/`: hidden results, for `recall_context`.

## Privacy

The classifier receives user and assistant text, tool inputs, and a short
sample of each candidate tool output. With a hosted classifier (Jev), that
leaves your machine. Use a self-hosted classifier if that matters.
Requests to Anthropic are forwarded as they are, credentials included;
nothing is logged except the decisions.

## Tests

```bash
npm test
```

22 checks against a fake Anthropic API and a fake classifier:
- hide and restore with hysteresis;
- decisions frozen within a turn;
- `count_tokens`;
- SSE streaming passthrough;
- `thinking` blocks and `cache_control` untouched;
- Claude Code's own messages not mutated;
- `recall_context` over MCP restoring in place;
- classifier down;
- a non-JSON request.

## Limitations

- Every decision that changes something costs one prompt-cache miss from
  the first changed block onward. Hysteresis keeps this rare, but it
  happens.
- Small classifiers are wrong sometimes: SemIf reports ~0.81 balanced
  accuracy. A wrongly hidden result costs a `recall_context` call or a
  re-read.
- **The evidence that classifier-based selection beats simple rules is
  thin.** Independent replays in the Jev ecosystem found small gains over
  "keep head+tail" or recency (see [RESEARCH.md](RESEARCH.md)). This
  project hasn't been measured that way yet. A replay benchmark is the most
  useful contribution anyone could make.
- The proxy decodes each `/v1/messages` request body in order to project
  it. Response bodies are streamed through untouched.

## Credits

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
  by tamaratran: the method and the state-building library, vendored
  unmodified under MIT in `vendor/fast-jev-compaction/`.
- [Jev](https://typesafe.ai) by TypeSafe AI, and
  [SemIf](https://github.com/TheoLeeCJ/SemIf) by Theodore Lee, for
  classifiers that answer yes/no questions with probabilities.

## License

MIT, see [LICENSE](LICENSE). The vendored library keeps its own MIT
license.
