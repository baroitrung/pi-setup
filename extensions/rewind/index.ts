// /rewind — keep the decisions, drop the bulk.
//
// A long session carries every tool result it ever produced. Most of it is
// exploration the model never needs again, and it is billed on every request.
// Rewind reshapes what the model sees without touching the session file:
//
//   • tool results older than the last `keepTail` messages become one-line stubs,
//   • user and assistant messages are never modified,
//   • /rewind off restores the full transcript instantly, because nothing was deleted.
//
// It plugs into the `context` hook, which Pi runs before each LLM call and whose
// returned messages are what the provider receives.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	formatSaved,
	parseArgs,
	planRewind,
	summarizeReport,
	type AnyMessage,
	type RewindConfig,
	type RewindReport,
} from "./lib/rewind.ts";

const ENTRY_TYPE = "rewind";

interface RewindState {
	armed: boolean;
	config: RewindConfig;
	last?: Pick<RewindReport, "pruned" | "savedChars" | "tools">;
}

function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	if (type === "info") console.log(text);
	else console.error(text);
}

function restore(ctx: ExtensionContext): RewindState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<RewindState> | undefined;
		if (!data || typeof data !== "object") return undefined;
		return {
			armed: data.armed === true,
			config: {
				keepTail: Number.isFinite(data.config?.keepTail) ? Number(data.config?.keepTail) : DEFAULT_CONFIG.keepTail,
				minResultChars: Number.isFinite(data.config?.minResultChars)
					? Number(data.config?.minResultChars)
					: DEFAULT_CONFIG.minResultChars,
			},
			...(data.last ? { last: data.last } : {}),
		};
	}
	return undefined;
}

export default function rewind(pi: ExtensionAPI): void {
	let state: RewindState = { armed: false, config: { ...DEFAULT_CONFIG } };
	let announced = false;

	function persist(): void {
		pi.appendEntry(ENTRY_TYPE, state);
	}

	pi.on("session_start", (_event, ctx) => {
		const restored = restore(ctx);
		if (restored) state = restored;
		announced = false;
	});

	pi.on("context", (event, ctx) => {
		if (!state.armed) return;
		const report = planRewind(event.messages as unknown as AnyMessage[], state.config);
		if (!report.changed) return undefined;
		state = {
			...state,
			last: { pruned: report.pruned, savedChars: report.savedChars, tools: report.tools },
		};
		if (!announced) {
			announced = true;
			notify(ctx, `rewind: ${summarizeReport(report)}`);
		}
		return { messages: report.messages as unknown as typeof event.messages };
	});

	pi.registerCommand("rewind", {
		description: "Trim old tool results from the model context (reversible)",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args, state.config);
			if (!parsed) {
				notify(ctx, "Usage: /rewind [on|off|status] [keep N] [min CHARS]", "warning");
				return;
			}

			if (parsed.action === "status") {
				const last = state.last
					? `Last pass: ${last.pruned} result(s), ${formatSaved(last.savedChars)} saved.`
					: "No pass applied yet in this session.";
				notify(
					ctx,
					[
						`rewind: ${state.armed ? "on" : "off"} · keep ${parsed.config.keepTail} messages · min ${parsed.config.minResultChars} chars`,
						last,
						"Applies to the next request; the session file is never modified.",
					].join("\n"),
				);
				return;
			}

			state = {
				armed: parsed.action === "arm",
				config: parsed.config,
				...(state.last ? { last: state.last } : {}),
			};
			persist();

			if (parsed.action === "off") {
				announced = false;
				notify(ctx, "rewind: off. The full transcript is back in context.");
				return;
			}

			notify(
				ctx,
				`rewind: on. Tool results older than the last ${state.config.keepTail} messages${
					state.config.minResultChars > 0 ? ` (≥${state.config.minResultChars} chars)` : ""
				} collapse on the next request. /rewind off restores them.`,
			);
		},
	});
}
