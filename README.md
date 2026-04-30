# pi-compact

A [pi](https://pi.dev) extension that triggers compaction at an **absolute
token count** — independent of the active model's context window — with
**per-model thresholds**, **mid-loop compaction with auto-resume**, and
live reconfiguration from inside pi.

## Why

Pi's built-in compaction fires when context usage approaches `contextWindow -
reserveTokens`. On long-context models that means compaction lands very late
(well past the point where throughput, cost, and response quality start to
degrade). This extension lets you set, e.g., "compact Claude Opus 4.7 at 150k
tokens, GPT-5.4 at 200k, everything else never" regardless of the reported
context window.

## Features

- Absolute token thresholds, not percentages or window-relative.
- Per-model configuration with `provider/id` keys and `provider/*` / `*/*`
  wildcards.
- Config layers: global settings → project settings → in-session overrides.
- Runtime `/compact-threshold` command with optional persistence to disk.
- Live reload: edits to either settings file take effect without restarting pi.
- Edge-triggered: compaction fires exactly once when you cross the threshold,
  not in a tight loop.
- Mid-loop compaction with auto-resume: compacts between turns while the
  agent is still working, then sends a follow-up message so the LLM continues
  the task automatically.
- Footer status readout (`compact-threshold: 83k / 150k`).

## Install

```bash
pi install git:github.com/<you>/pi-compact
```

Or from a local checkout:

```bash
pi install /path/to/pi-compact
# or, for a throwaway trial:
pi -e /path/to/pi-compact/extensions/compact-threshold.ts
```

## Configure

Add a `compactThreshold` block to `~/.pi/agent/settings.json` (global) and/or
`<project>/.pi/settings.json` (project-local, overrides global):

```json
{
  "compactThreshold": {
    "enabled": true,
    "default": 150000,
    "models": {
      "anthropic/claude-opus-4.7": 180000,
      "openrouter/anthropic/claude-opus-4.7": 180000,
      "openai/gpt-5.4": 200000,
      "openrouter/*": 120000
    }
  }
}
```

Field reference:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Master switch. Default `true`. |
| `default` | number \| null | Fallback threshold in tokens when no model entry matches. `null` means no auto-compaction. |
| `models` | object | Map of `provider/id` → token count. `null` disables for a specific model. |

Model keys are matched as `<provider>/<id>`. Wildcards supported:
- `"provider/*"` — any id under that provider
- `"*/id"` — that id across providers
- `"*"` — any model (lower priority than `default`? no: `*` wins over `default`)

Numbers can be written as `150000`, `150_000`, `150k`, or `1.5M` when set via
the command.

## Commands

Type these inside pi. Effect is immediate unless noted.

| Command | Effect |
|---|---|
| `/compact-threshold` | Show effective threshold for current model. |
| `/compact-threshold show` | Print full merged config. |
| `/compact-threshold <N>` | Set threshold for current model (session-only). |
| `/compact-threshold <N> save` | Same, but persist to `~/.pi/agent/settings.json`. |
| `/compact-threshold off` | Disable auto-compaction for current model. |
| `/compact-threshold default <N\|off>` | Set fallback default. Add `save` to persist. |
| `/compact-threshold enable` / `disable` | Master switch. Add `save` to persist. |
| `/compact-threshold reload` | Re-read both settings files. |

Examples:

```
/compact-threshold 150k                 ← this model, this session
/compact-threshold 180_000 save         ← this model, persisted globally
/compact-threshold default 120k save
/compact-threshold off                  ← disable for this model only
/compact-threshold show
```

## How it works

- Subscribes to `turn_end` — fired after each LLM response within the
  agent loop. When the LLM has `stopReason === "tool_use"` (calling tools,
  mid-loop) and the threshold is exceeded, **aborts the agent immediately**
  via `ctx.abort()`, then compacts. The abort sets the agent's abort signal
  synchronously, so the next `streamAssistantResponse` call in the loop
  sees an already-aborted signal and fails immediately — no HTTP request
  is sent, no tokens wasted. After compaction, sends a follow-up
  `"Continue what you were doing."` message to automatically resume.
- Also subscribes to `agent_end` — when the loop finishes normally
  (not mid-loop), compacts without resume if the threshold was exceeded.
  This catches cases where the agent stopped without calling tools but
  the context is still over the threshold.
- Reads `usage` directly from the assistant message of the finished turn
  (via the exported `calculateContextTokens`), falling back to
  `ctx.getContextUsage()` if usage is missing.
- Fires `ctx.compact()` on the **rising edge** — i.e., the previous turn
  was at or below the threshold and this one is above it. That prevents
  re-triggering while a compaction is in flight or if usage flaps across turns.
- After mid-loop compaction completes, sends a
  `sendUserMessage("Continue what you were doing.")` follow-up so the
  agent automatically resumes the in-progress task with the freshly
  compacted context.
- Passes `customInstructions` to compaction ("Focus on the in-progress task
  and what remains to be done.") when resuming, so the summary preserves
  task continuity.
- Mirrors the built-in's guards:
  - Skips when `stopReason === "aborted"` (user hit Esc).
  - Skips when the assistant message predates the latest `CompactionEntry` on
    the current branch (would use stale pre-compaction usage otherwise). Uses
    the exported `getLatestCompactionEntry`.
  - Skips when the assistant message came from a different model than the
    currently selected one (usage reflects the wrong model).
- `turn_end` triggers mid-loop compaction (with abort + resume).
- `agent_end` triggers end-of-loop compaction when the threshold is
  exceeded but the agent wasn't mid-loop (no resume).
- `model_select` resets the edge-tracker so switching models applies the new
  threshold from the next turn.
- `fs.watch` is attached to both settings files; config is re-merged whenever
  either changes.

## Interaction with built-in compaction

Mid-loop compaction (`turn_end` + `ctx.abort()`) fires earlier than the
built-in's `_checkCompaction()` at `agent_end`. Pi's compaction pipeline
guards against running a second compaction while one is already active
(`isCompacting`), so if our extension fires mid-loop, the built-in's
end-of-loop check is a no-op. If the agent finishes before crossing your
threshold, the built-in or our `agent_end` handler may still fire.

In practice: set your per-model threshold **below** `contextWindow -
reserveTokens` for the models you care about, and this extension becomes the
effective trigger. The built-in stays as a safety net for overflow errors and
models without a configured threshold.

## Development

The extension is a single file: `extensions/compact-threshold.ts`. It's loaded
via [jiti](https://github.com/unjs/jiti) — no build step.

To iterate locally, symlink it into pi's auto-discover directory:

```bash
ln -s "$PWD/extensions/compact-threshold.ts" ~/.pi/agent/extensions/compact-threshold.ts
```

Then `/reload` inside pi after edits.

## License

MIT.
