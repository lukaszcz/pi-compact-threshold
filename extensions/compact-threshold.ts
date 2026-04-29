/**
 * compact-threshold
 * -----------------
 * Trigger compaction at an **absolute token count** (independent of the model's
 * context window), configurable **per-model**, with **auto-resume** after
 * mid-loop compaction.
 *
 * Configuration (merged in this order, later wins):
 *   1. `~/.pi/agent/settings.json`   (global)
 *   2. `<cwd>/.pi/settings.json`     (project-local)
 *   3. In-session overrides (via `/compact-threshold ...` while pi is running)
 *
 * Settings shape (put under the top-level key `compactThreshold`):
 *
 *   {
 *     "compactThreshold": {
 *       "enabled": true,                       // default true
 *       "default": 150000,                     // fallback if no per-model entry (null = no auto-compact)
 *       "models": {
 *         "anthropic/claude-opus-4.7": 180000,
 *         "openai/gpt-5.4":            200000,
 *         "openrouter/*":              120000   // "*" wildcard on the id part is supported
 *       }
 *     }
 *   }
 *
 * Keys under `models` are matched as `<provider>/<id>`. You can use `"*"` as the
 * id to match any model from a provider, or omit the key entirely to fall back
 * to `default`.
 *
 * Commands (change at runtime, effect is immediate):
 *   /compact-threshold                      Show current effective threshold.
 *   /compact-threshold show                 Print full merged configuration.
 *   /compact-threshold <N>                  Set threshold for the *current* model (session only).
 *   /compact-threshold <N> save             Same, but persist to ~/.pi/agent/settings.json.
 *   /compact-threshold off                  Disable auto-compaction for current model (session).
 *   /compact-threshold off save             Same, persisted.
 *   /compact-threshold default <N|off>      Set the fallback default.
 *   /compact-threshold default <N|off> save Same, persisted.
 *   /compact-threshold enable|disable       Turn the whole extension on/off (session).
 *   /compact-threshold reload               Re-read settings files.
 *
 * Numbers may be written as `150000`, `150_000`, `150k`, or `1.5M`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	calculateContextTokens,
	type ExtensionAPI,
	type ExtensionContext,
	getLatestCompactionEntry,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThresholdConfig {
	enabled: boolean;
	default: number | null; // null = no auto-compaction if no per-model entry
	models: Record<string, number | null>; // null = explicitly disabled for that model
}

const DEFAULT_CONFIG: ThresholdConfig = {
	enabled: true,
	default: null,
	models: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GLOBAL_SETTINGS = path.join(os.homedir(), ".pi", "agent", "settings.json");
const projectSettings = (cwd: string) => path.join(cwd, ".pi", "settings.json");

function readJson(file: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(file, "utf8");
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function parseTokenCount(input: string): number | null {
	const cleaned = input.trim().toLowerCase().replace(/_/g, "").replace(/,/g, "");
	const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return null;
	const unit = m[2];
	const value = unit === "k" ? n * 1_000 : unit === "m" ? n * 1_000_000 : n;
	return Math.floor(value);
}

function formatTokens(n: number | null | undefined): string {
	if (n == null) return "off";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
	return `${n}`;
}

function modelKey(model: { provider?: string; id?: string } | undefined | null): string | null {
	if (!model?.provider || !model?.id) return null;
	return `${model.provider}/${model.id}`;
}

// Find the best threshold for a model. Checks exact, then provider wildcard,
// then id wildcard, then global wildcard, then default.
function resolveThreshold(cfg: ThresholdConfig, key: string | null): number | null {
	if (!cfg.enabled) return null;
	if (key && key in cfg.models) return cfg.models[key] ?? null;
	if (key) {
		const [provider, ...rest] = key.split("/");
		const id = rest.join("/");
		const providerWild = `${provider}/*`;
		if (providerWild in cfg.models) return cfg.models[providerWild] ?? null;
		const idWild = `*/${id}`;
		if (idWild in cfg.models) return cfg.models[idWild] ?? null;
	}
	if ("*" in cfg.models) return cfg.models["*"] ?? null;
	return cfg.default;
}

/** Deep-ish merge for our tiny shape. Later layers override earlier ones. */
function mergeConfig(...layers: Array<Partial<ThresholdConfig> | null | undefined>): ThresholdConfig {
	const result: ThresholdConfig = { ...DEFAULT_CONFIG, models: {} };
	for (const layer of layers) {
		if (!layer) continue;
		if (typeof layer.enabled === "boolean") result.enabled = layer.enabled;
		if ("default" in layer) result.default = layer.default ?? null;
		if (layer.models && typeof layer.models === "object") {
			for (const [k, v] of Object.entries(layer.models)) {
				if (v === null || typeof v === "number") result.models[k] = v;
			}
		}
	}
	return result;
}

function readLayerFromFile(file: string): Partial<ThresholdConfig> | null {
	const json = readJson(file);
	if (!json || typeof json !== "object") return null;
	const raw = (json as Record<string, unknown>).compactThreshold;
	if (!raw || typeof raw !== "object") return null;
	return raw as Partial<ThresholdConfig>;
}

/**
 * Persist the extension config under the `compactThreshold` key of the global
 * settings file, preserving all other keys.
 */
function persistGlobal(patch: Partial<ThresholdConfig>): void {
	const dir = path.dirname(GLOBAL_SETTINGS);
	fs.mkdirSync(dir, { recursive: true });
	const existing = readJson(GLOBAL_SETTINGS) ?? {};
	const current = (existing as Record<string, unknown>).compactThreshold;
	const base: Partial<ThresholdConfig> =
		current && typeof current === "object" ? (current as Partial<ThresholdConfig>) : {};
	const next: Partial<ThresholdConfig> = { ...base };
	if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
	if ("default" in patch) next.default = patch.default ?? null;
	if (patch.models) {
		next.models = { ...(base.models ?? {}) };
		for (const [k, v] of Object.entries(patch.models)) {
			if (v === undefined) delete next.models[k];
			else next.models[k] = v;
		}
	}
	(existing as Record<string, unknown>).compactThreshold = next;
	fs.writeFileSync(GLOBAL_SETTINGS, `${JSON.stringify(existing, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** Layers, in merge order (later overrides earlier). */
	let globalLayer: Partial<ThresholdConfig> | null = readLayerFromFile(GLOBAL_SETTINGS);
	let projectLayer: Partial<ThresholdConfig> | null = null; // set on session_start once cwd is known
	let sessionLayer: Partial<ThresholdConfig> = { models: {} };
	let effective: ThresholdConfig = mergeConfig(globalLayer, projectLayer, sessionLayer);

	/** Edge-trigger state: token count at end of previous turn. */
	let previousTokens: number | null = null;
	let compacting = false;

	const watchers: fs.FSWatcher[] = [];

	function recompute(): void {
		effective = mergeConfig(globalLayer, projectLayer, sessionLayer);
	}

	function describeThreshold(ctx: ExtensionContext): string {
		const key = modelKey(ctx.model);
		const threshold = resolveThreshold(effective, key);
		const source =
			key && key in (sessionLayer.models ?? {})
				? "session override"
				: key && key in (projectLayer?.models ?? {})
					? "project settings"
					: key && key in (globalLayer?.models ?? {})
						? "global settings"
						: threshold === effective.default
							? "fallback default"
							: "wildcard";
		return `${key ?? "no model"} → ${formatTokens(threshold)} (${source})`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const key = modelKey(ctx.model);
		const threshold = resolveThreshold(effective, key);
		if (!effective.enabled) {
			ctx.ui.setStatus("compact-threshold", "compact-threshold: disabled");
			return;
		}
		if (threshold == null) {
			ctx.ui.setStatus("compact-threshold", `compact-threshold: off (${key ?? "no model"})`);
			return;
		}
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;
		ctx.ui.setStatus(
			"compact-threshold",
			`compact-threshold: ${formatTokens(tokens)} / ${formatTokens(threshold)}`,
		);
	}

	/**
	 * Check whether compaction should fire based on the current token usage
	 * and the configured threshold.
	 *
	 * `lastAssistant` is the assistant message from the finished turn.
	 * It may be undefined (e.g. turn_end with no assistant response).
	 *
	 * When `resume` is true, a follow-up user message is sent after compaction
	 * completes to automatically continue the agent's in-progress work.
	 */
	function maybeCompact(
		ctx: ExtensionContext,
		lastAssistant:
			| {
					role: "assistant";
					provider?: string;
					model?: string;
					stopReason?: string;
					timestamp?: number;
					usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			  }
			| undefined,
		resume: boolean,
	): void {
		if (!effective.enabled || compacting) return;
		const key = modelKey(ctx.model);
		const threshold = resolveThreshold(effective, key);

		// Pull current tokens from the assistant message's usage (authoritative,
		// matches what built-in _checkCompaction reads). Fall back to estimator.
		const currentTokens = lastAssistant?.usage
			? calculateContextTokens(lastAssistant.usage)
			: (ctx.getContextUsage()?.tokens ?? null);

		if (threshold == null) {
			previousTokens = currentTokens;
			return;
		}
		if (currentTokens === null) return;

		// Guard 1: skip if the turn was aborted (user hit Esc). The built-in does
		// the same — an aborted assistant message has partial/stale usage that
		// shouldn't drive a compaction decision.
		if (lastAssistant?.stopReason === "aborted") {
			previousTokens = currentTokens;
			return;
		}

		// Guard 2: skip if the assistant message predates the latest compaction
		// entry on the current branch. Without this we'd re-fire on the very next
		// turn_end using stale pre-compaction usage. This mirrors the built-in's
		// `assistantIsFromBeforeCompaction` check.
		const latestCompaction = getLatestCompactionEntry(ctx.sessionManager.getBranch());
		if (
			latestCompaction &&
			lastAssistant?.timestamp !== undefined &&
			lastAssistant.timestamp <= new Date(latestCompaction.timestamp).getTime()
		) {
			previousTokens = null;
			return;
		}

		// Guard 3: if the assistant message is from a *different* model than the
		// currently-selected one (e.g. user just switched mid-session), usage
		// reflects the old model. Skip this turn; the next turn_end on the new
		// model will make an honest decision.
		if (
			lastAssistant &&
			ctx.model &&
			(lastAssistant.provider !== ctx.model.provider || lastAssistant.model !== ctx.model.id)
		) {
			previousTokens = null;
			return;
		}

		// Edge-triggered: only fire when we *cross* the threshold between
		// turns. On first check (previousTokens === null), fire only if already past.
		const wasUnder = previousTokens === null ? true : previousTokens <= threshold;
		const nowOver = currentTokens > threshold;
		previousTokens = currentTokens;

		if (!wasUnder || !nowOver) return;

		compacting = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Compacting: ${formatTokens(currentTokens)} exceeds threshold ${formatTokens(threshold)} for ${key}`,
				"info",
			);
		}
		ctx.compact({
			customInstructions: resume
				? "Focus on the in-progress task and what remains to be done."
				: undefined,
			onComplete: () => {
				compacting = false;
				// Reset baseline so the post-compaction state is "below threshold"
				// until usage from a fresh turn_end says otherwise.
				previousTokens = null;
				if (ctx.hasUI) ctx.ui.notify("Compaction complete", "info");
				updateStatus(ctx);
				if (resume) {
					pi.sendUserMessage("Continue what you were doing.");
				}
			},
			onError: (error) => {
				compacting = false;
				if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
			},
		});
	}

	// --- File watchers: live reload config on edit ----------------------------
	function watchFile(file: string, onChange: () => void): void {
		try {
			const dir = path.dirname(file);
			if (!fs.existsSync(dir)) return;
			const base = path.basename(file);
			const w = fs.watch(dir, { persistent: false }, (_evt, name) => {
				if (!name || name === base) onChange();
			});
			watchers.push(w);
		} catch {
			// ignore
		}
	}

	// --- Lifecycle ------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		projectLayer = readLayerFromFile(projectSettings(ctx.cwd));
		globalLayer = readLayerFromFile(GLOBAL_SETTINGS);
		recompute();
		previousTokens = null;

		// Live reload when either file changes
		watchFile(GLOBAL_SETTINGS, () => {
			globalLayer = readLayerFromFile(GLOBAL_SETTINGS);
			recompute();
			if (ctx.hasUI) {
				ctx.ui.notify(`compact-threshold: reloaded global settings → ${describeThreshold(ctx)}`, "info");
			}
			updateStatus(ctx);
		});
		watchFile(projectSettings(ctx.cwd), () => {
			projectLayer = readLayerFromFile(projectSettings(ctx.cwd));
			recompute();
			if (ctx.hasUI) {
				ctx.ui.notify(`compact-threshold: reloaded project settings → ${describeThreshold(ctx)}`, "info");
			}
			updateStatus(ctx);
		});

		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		for (const w of watchers) {
			try {
				w.close();
			} catch {
				// ignore
			}
		}
		watchers.length = 0;
	});

	pi.on("model_select", async (_event, ctx) => {
		// Reset edge-trigger when model changes — thresholds may differ.
		previousTokens = null;
		updateStatus(ctx);
	});

	// `turn_end` — compaction decision point. Compacts on the rising edge
	// whenever the threshold is exceeded. Auto-resume (sending a follow-up
	// message) only happens when the agent is mid-loop (stopReason is
	// tool_use), since there's nothing to continue if the agent has finished.
	pi.on("turn_end", (event, ctx) => {
		const lastAssistant = event.message as Parameters<typeof maybeCompact>[1] | undefined;
		const isMidLoop = lastAssistant?.stopReason === "tool_use";
		maybeCompact(ctx, lastAssistant, isMidLoop);
		updateStatus(ctx);
	});

	// `agent_end` — status update only. Compaction decisions happen at
	// `turn_end`; by the time the agent loop finishes, any compaction has
	// already been handled.
	pi.on("agent_end", (_event, ctx) => {
		updateStatus(ctx);
	});

	// --- Command --------------------------------------------------------------
	pi.registerCommand("compact-threshold", {
		description: "Set/show compaction token threshold (per-model, absolute)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "show", label: "show — print full config" },
				{ value: "default", label: "default <N|off> — set fallback" },
				{ value: "off", label: "off — disable for current model (session)" },
				{ value: "enable", label: "enable — turn on" },
				{ value: "disable", label: "disable — turn off" },
				{ value: "reload", label: "reload — re-read settings files" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			// `/compact-threshold` with no args — show effective threshold
			if (tokens.length === 0) {
				ctx.ui.notify(describeThreshold(ctx), "info");
				return;
			}

			const cmd = tokens[0].toLowerCase();
			const save = tokens.some((t) => t.toLowerCase() === "save" || t === "--save");

			if (cmd === "show") {
				const lines: string[] = [];
				lines.push(`enabled: ${effective.enabled}`);
				lines.push(`default: ${formatTokens(effective.default)}`);
				lines.push(`current: ${describeThreshold(ctx)}`);
				const entries = Object.entries(effective.models);
				if (entries.length > 0) {
					lines.push("per-model:");
					for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
						lines.push(`  ${k} → ${formatTokens(v)}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (cmd === "reload") {
				globalLayer = readLayerFromFile(GLOBAL_SETTINGS);
				projectLayer = readLayerFromFile(projectSettings(ctx.cwd));
				recompute();
				updateStatus(ctx);
				ctx.ui.notify(`compact-threshold reloaded → ${describeThreshold(ctx)}`, "info");
				return;
			}

			if (cmd === "enable" || cmd === "disable") {
				const enabled = cmd === "enable";
				sessionLayer.enabled = enabled;
				recompute();
				if (save) persistGlobal({ enabled });
				previousTokens = null;
				updateStatus(ctx);
				ctx.ui.notify(
					`compact-threshold ${enabled ? "enabled" : "disabled"}${save ? " (saved globally)" : ""}`,
					"info",
				);
				return;
			}

			if (cmd === "default") {
				const arg = tokens[1];
				if (!arg) {
					ctx.ui.notify(
						`default threshold: ${formatTokens(effective.default)}. Usage: /compact-threshold default <N|off> [save]`,
						"warning",
					);
					return;
				}
				const value = arg.toLowerCase() === "off" ? null : parseTokenCount(arg);
				if (arg.toLowerCase() !== "off" && (value === null || value <= 0)) {
					ctx.ui.notify(`Invalid token count: "${arg}"`, "error");
					return;
				}
				sessionLayer.default = value;
				recompute();
				if (save) persistGlobal({ default: value });
				previousTokens = null;
				updateStatus(ctx);
				ctx.ui.notify(
					`Default threshold → ${formatTokens(value)}${save ? " (saved globally)" : " (session)"}`,
					"info",
				);
				return;
			}

			// Otherwise: treat first token as a value for the current model.
			const key = modelKey(ctx.model);
			if (!key) {
				ctx.ui.notify("No active model — select one with /model first.", "warning");
				return;
			}
			const value = cmd === "off" ? null : parseTokenCount(cmd);
			if (cmd !== "off" && (value === null || value <= 0)) {
				ctx.ui.notify(
					`Invalid argument: "${cmd}". Try /compact-threshold <N>, off, default, show, enable, disable, reload.`,
					"error",
				);
				return;
			}
			sessionLayer.models = { ...(sessionLayer.models ?? {}), [key]: value };
			recompute();
			if (save) persistGlobal({ models: { [key]: value } });
			previousTokens = null;
			updateStatus(ctx);
			ctx.ui.notify(
				`${key} → ${formatTokens(value)}${save ? " (saved globally)" : " (session)"}`,
				"info",
			);
		},
	});
}
