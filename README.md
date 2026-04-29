# pi-compact

A [pi](https://pi.dev) extension that triggers compaction at an **absolute
token count** — independent of the active model's context window — with
**per-model thresholds** and live reconfiguration from inside pi.

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

- Subscribes to `turn_end`. After every assistant turn it reads
  `ctx.getContextUsage().tokens` and compares to the effective threshold for
  `ctx.model.provider/ctx.model.id`.
- Fires `ctx.compact()` on the **rising edge** — i.e., the previous turn was at
  or below the threshold and this turn is above it. That prevents re-triggering
  while pi is already compacting or if usage flaps slightly across turns.
- After each compaction, the reference token count is refreshed so the next
  edge is detected from the post-compaction state.
- `model_select` resets the edge-tracker so switching models applies the new
  threshold immediately.
- `fs.watch` is attached to both settings files; config is re-merged whenever
  either changes.

## Interaction with built-in compaction

Pi's built-in auto-compaction still runs based on `compaction.reserveTokens`.
This extension triggers **additionally**, earlier. If you want this extension
to be the only trigger, keep your thresholds below the built-in cutoff for
that model.

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
