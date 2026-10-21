// The pruning planner. Pure: takes messages, returns a new list plus a report.
//
// Rewind never edits the session file. It reshapes the context Pi hands to the
// model on each request (`context` hook), so /rewind off restores the full
// transcript instantly and nothing is lost on disk.

export interface RewindConfig {
	/** Keep this many trailing messages verbatim. */
	keepTail: number;
	/** Only replace tool results at least this large. */
	minResultChars: number;
}

export const DEFAULT_CONFIG: RewindConfig = { keepTail: 8, minResultChars: 1_500 };

export const STUB_PREFIX = "[rewound ";

/** Shape we touch. Structural on purpose: pi's message types are large and optional here. */
export interface AnyMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
	[tool: string]: unknown;
}

export interface RewindReport {
	changed: boolean;
	pruned: number;
	savedChars: number;
	/** tool name → number of pruned results */
	tools: Record<string, number>;
	messages: AnyMessage[];
}

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const record = part as { type?: unknown; text?: unknown; data?: unknown };
		if (record.type === "text" && typeof record.text === "string") total += record.text.length;
		else if (record.type === "image" && typeof record.data === "string") total += record.data.length;
	}
	return total;
}

function imageCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image").length;
}

export function isStub(message: AnyMessage): boolean {
	if (!Array.isArray(message.content)) return false;
	const [first] = message.content as { type?: unknown; text?: unknown }[];
	return Boolean(first && first.type === "text" && typeof first.text === "string" && first.text.startsWith(STUB_PREFIX));
}

/**
 * Replaces bulky tool results before `messages.length - keepTail` with a one-line
 * stub. User and assistant messages are never touched: decisions and instructions
 * are the part worth keeping.
 */
export function planRewind(messages: readonly AnyMessage[], config: RewindConfig = DEFAULT_CONFIG): RewindReport {
	const keepTail = Math.max(0, Math.trunc(config.keepTail));
	const minResultChars = Math.max(0, Math.trunc(config.minResultChars));
	const cutoff = messages.length - keepTail;
	const tools: Record<string, number> = {};
	let pruned = 0;
	let savedChars = 0;

	const next = messages.map((message, index) => {
		if (index >= cutoff) return message;
		if (message?.role !== "toolResult") return message;
		if (isStub(message)) return message;

		const chars = textLength(message.content);
		if (chars < minResultChars) return message;

		const images = imageCount(message.content);
		const toolName = typeof message.toolName === "string" && message.toolName ? message.toolName : "tool";
		const label = `${STUB_PREFIX}${toolName} output · ${chars.toLocaleString("en-US")} chars${
			images > 0 ? ` · ${images} image(s)` : ""
		} omitted to keep the context small. Re-run the tool if you need it again.]`;

		pruned += 1;
		savedChars += chars;
		tools[toolName] = (tools[toolName] ?? 0) + 1;
		return { ...message, content: [{ type: "text", text: label }] };
	});

	return { changed: pruned > 0, pruned, savedChars, tools, messages: next };
}

export function formatSaved(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	if (chars >= 1_000) return `${Math.round(chars / 1_000)} KB`;
	return `${chars} chars`;
}

export function summarizeReport(report: RewindReport): string {
	const parts = Object.entries(report.tools)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([tool, count]) => `${tool}×${count}`);
	return `${report.pruned} tool result(s), ${formatSaved(report.savedChars)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** Parses `/rewind` arguments. Returns undefined for an unknown argument. */
export function parseArgs(args: string, current: RewindConfig): { config: RewindConfig; action: "arm" | "off" | "status" } | undefined {
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const config = { ...current };
	let action: "arm" | "off" | "status" = "arm";

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word === "off" || word === "stop") action = "off";
		else if (word === "status") action = "status";
		else if (word === "on" || word === "arm") action = "arm";
		else if (word === "keep" || word === "--keep") {
			const value = Number(words[++i]);
			if (!Number.isFinite(value) || value < 1) return undefined;
			config.keepTail = Math.trunc(value);
		} else if (word === "min" || word === "--min") {
			const value = Number(words[++i]);
			if (!Number.isFinite(value) || value < 0) return undefined;
			config.minResultChars = Math.trunc(value);
		} else return undefined;
	}
	return { config, action };
}

