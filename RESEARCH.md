# Prior art: context injection with Jev and small classifiers

Survey made on **26 September 2026**, before building this project, to check
whether someone had already done it. Star counts are as of that date. Almost
none of the Jev-ecosystem results are peer-reviewed; most are single-author
replays. Where a claim couldn't be verified, it says so.

## Verdict

- **No project found does the full combination**:
  - Jev-style keep/drop per tool call;
  - re-scoring **every** old tool result (hidden ones included) against
    **each new user request**, with automatic hide and restore and
    hysteresis;
  - a recall-by-id tool;
  - a small classifier.

  Each piece exists somewhere, and most appeared in the eleven days after
  Jev launched (15 Sep 2026).
- **For Claude Code specifically**: nothing found does per-prompt,
  reversible, **in-place** hiding and restoring of individual old tool
  results.
- **The evidence that classifier-based selection pays off is thin.** Several
  independent replays found Jev-style selection barely beats simple rules:
  - with outputs shown as "(omitted)", Jev's decisions were nearly identical
    to a "drop every non-pinned result" rule
    ([#26](https://github.com/tamaratran/fast-jev-compaction/issues/26));
  - Laya, SWE-Pruner, Needle 3 and even a next-message oracle didn't
    meaningfully beat keeping head+tail
    ([#99](https://github.com/tamaratran/fast-jev-compaction/issues/99));
  - [ctxjev](https://github.com/x96x64/ctxjev) made plain recency its
    default scorer after a preregistered evaluation;
  - in [jcressler's Codex port](https://github.com/jcressler/fast-jev-compaction-codex)
    "Jev did not meet the preregistered added-value threshold".

## Background

- **Jev** is TypeSafe AI's closed "System One" model: typed decisions with
  probabilities, including yes/no "noul" questions. 32k context, $0.042 per
  million input tokens.
  ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
  [docs](https://docs.typesafe.ai/introduction),
  [HN](https://news.ycombinator.com/item?id=49717558))
- **[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)**
  is a Claude Code plugin by tamaratran, MIT-licensed, ~6.9k stars. It
  overrides compaction through Claude Code's experimental function hooks
  (`session.compact`, behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).
  - Irreversible by design.
  - Each compaction is a full cache miss.
  - `--resume` undoes it
    ([#89](https://github.com/tamaratran/fast-jev-compaction/issues/89)).
  - No merges since 18 Sep.
  - An open PR adds a SemIf backend
    ([#93](https://github.com/tamaratran/fast-jev-compaction/pull/93)).
- **[SemIf](https://github.com/TheoLeeCJ/SemIf)** (formerly "OpenJev", ~4.4k
  stars, MIT) scores options from Qwen3.5-4B logits, with per-workload
  temperature calibration. It is a command-line tool, not a server.

## Closest works, general

| work | what it does | difference from this project |
|---|---|---|
| [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) | two `noul` questions per call at compaction time (keep the call? keep the result?) | threshold-triggered, permanent; no per-request relevance, no restore |
| [pi-jev-context](https://github.com/kevinpita/pi-jev-context) (Pi) | hides low-keep messages from requests; history stays intact; `/rejev` re-judges, hidden items included | reversible, but re-judging is manual; its README says cached scores "do not automatically adapt to a new topic"; no hysteresis, no recall |
| [pi-jev-prune](https://github.com/fsmiamoto/pi-jev-prune) (Pi) | stale outputs become stubs with `recall(toolCallId)`; changes only at cache "windows" | recall exists, but never re-scores or auto-restores; unbatched pruning cost more than it saved |
| [winnow](https://github.com/GhalebDweikat/winnow) | judges ~25-line blocks as results arrive, hides only confident "no"s behind a restore key; at prompt time ranks and injects memory files | per-request relevance, but for memory files; stubs are permanent and recall appends |
| [jevselector](https://github.com/universam1/jevselector) | per request, selects relevant tools and skills (−52–56% system prompt) | same per-request pattern, applied to tools and skills |
| [fast-jev-compaction-codex](https://github.com/jcressler/fast-jev-compaction-codex) | one question per task requirement; immutable archive with `search`/`retrieve` | recovery after compaction, not live hiding |
| [ctxjev](https://github.com/x96x64/ctxjev) | goal relevance: drop < 0.3, summarise < 0.6 | permanent; dropped Jev as default scorer |
| [opencode-DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning) | the main LLM prunes via a `compress` tool | no classifier |
| [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | `clear_tool_uses` by age | "cleared content cannot be restored"; not exposed by Claude Code |
| [Manus](https://rlancemartin.github.io/2025/10/15/manus/), [DTOC](https://arxiv.org/abs/2609.26121), [Sculptor](https://arxiv.org/abs/2508.04664) | full and compact forms of each result, restore on demand; in DTOC's ablation, hide-only variants did worse and adding restore recovered accuracy | the agent decides, not a classifier |
| [SWE-Pruner](https://arxiv.org/abs/2601.16746), [LaMR](https://arxiv.org/abs/2605.15315) | small models prune lines inside one output | within an output, not re-scored across requests |
| [The Complexity Trap](https://arxiv.org/abs/2508.21433) | observation masking matches LLM summarisation at about half the cost | the baseline to beat |

## Claude Code specifically

| project | mechanism | reversible? | re-scored per prompt? |
|---|---|---|---|
| [Headroom](https://github.com/headroomlabs-ai/headroom) (~74k stars) | `ANTHROPIC_BASE_URL` proxy; content-type compression; `headroom_retrieve` tool by hash; keyword-triggered expansion appended to the latest user turn | yes via retrieve (originals kept with a TTL) | partly: expansion is **appended**, not in place; compression is by content type, not relevance |
| [winnow](https://github.com/GhalebDweikat/winnow) | function hooks: `tool.call` stubs, MCP `winnow_recall` | only via recall (appended) | no, for tool results |
| [jev-pruner](https://github.com/tamaratran/jev-pruner) | `tool.call` on Bash; full output archived to a file | via the file | no |
| [yoshi](https://github.com/compozy/yoshi) | Bun proxy + Jev; span omissions validated by hash | no ("decisions are frozen") | no |
| [trimwire](https://github.com/AZagatti/trimwire) | Rust proxy, deterministic cache-safe strategies | transcript untouched | rule-based |
| [cozempic](https://github.com/Ruya-AI/cozempic), cc-prune, better-compact | rewrite the session JSONL, then resume | whole-file backup only | no |

Official hook capabilities, from the [hooks docs](https://code.claude.com/docs/en/hooks):
- `additionalContext` is append-only;
- `UserPromptSubmit` "can't replace the prompt";
- `PostToolUse` `updatedToolOutput` rewrites a result **as it arrives**;
- `PreCompact` can only block.

No hook can edit earlier messages. Hence the proxy.

## Classifiers as a "stop" verifier (related)

- **[jev-belay](https://github.com/valentynkit/jev-belay)**:
  - asks Jev only if files were edited and no check passed afterwards;
  - four questions combined reach AUROC 0.976 (0.777 from wording alone);
  - on 100 labelled stops it caught 7 of 12 false "done"s, with 1 wrong
    block per 100;
  - loop limits: one block per prompt, none within 60 s, at most three per
    session.
- **[clear-head](https://github.com/VladyslavHontar/clear-head)**: checks
  claims against what the agent actually read.

## Ideas adopted, and still open

Adopted here:
- show the classifier a **content sample** (head+tail), not "(omitted)";
- **deterministic pins** before the classifier: failed calls, edits,
  subagent reports and todos are never hidden;
- change the context **only at user turns**, frozen within a turn, with
  hysteresis (cache-aware, as in pi-jev-prune and Anthropic's
  `clear_at_least`);
- restore **in place** instead of appending.

Worth trying next:
- salvage identifiers into the stub: paths, SHAs, exit codes, error lines
  ([PR #105](https://github.com/tamaratran/fast-jev-compaction/pull/105));
- judge smaller units, and hide only confident "no"s (winnow);
- one question per requirement of the request (jcressler);
- calibrate the classifier (temperature scaling, as SemIf does) before
  trusting 0.4/0.6;
- **evaluate by replay** against head+tail, recency and masking baselines,
  excluding tokens the agent later rewrote itself
  ([#99](https://github.com/tamaratran/fast-jev-compaction/issues/99)).
