import { copyToClipboard, getLanguageFromPath, getMarkdownTheme, type ExtensionAPI, Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, Markdown, mixColors, Text, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

// Shared through a symbol so an extension reload cannot stack prototype adapters.
const KEY = Symbol.for("pi-setup.code-block.runtime");
interface Runtime {
	showPath: boolean;
	copy: (text: string) => Promise<void>;
	notify: (text: string, error?: boolean) => void;
	components: Set<WeakRef<Component>>;
	revision: number;
	palette?: () => Theme;
	paintScope?: Map<string, string>;
}
const globals = globalThis as typeof globalThis & { [KEY]?: Runtime };
function runtime(): Runtime | undefined { return globals[KEY]; }
const label = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export interface Fence { code: string; language: string; path?: string; open: boolean }

const nativeMarkdownRender = Markdown.prototype.render;
let extracting = false;

/** Reuse Pi's parser structure; map its tab-expanded offsets back to exact source. */
export function fences(source: string): Fence[] {
	source = source.replace(/\r\n?/g, "\n");
	const offsets: number[] = [];
	let normalized = "";
	for (let i = 0; i < source.length; i++) {
		const part = source[i] === "\t" ? "   " : source[i];
		normalized += part;
		for (let j = 0; j < part.length; j++) offsets.push(i);
	}
	offsets.push(source.length);
	const theme = getMarkdownTheme();
	const probe = new Markdown(source, 0, 0, { ...theme, highlightCode: undefined }, undefined, { renderLatex: false });
	const previous = extracting;
	extracting = true;
	try { nativeMarkdownRender.call(probe, 80); } finally { extracting = previous; }
	const tokens = (probe as unknown as { cachedTokens?: WeakRef<{ tokens: Token[] }> }).cachedTokens?.deref()?.tokens ?? [];
	const result: Fence[] = [];
	let from = 0;
	for (const token of tokens) {
		const position = normalized.indexOf(token.raw ?? "", from);
		if (position < 0 || !token.raw) continue;
		from = position + token.raw.length;
		if (token.type !== "code") continue;
		const raw = source.slice(offsets[position], offsets[from]);
		const lines = raw.split("\n");
		const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[0]);
		if (!match) continue; // Indented code is not a fenced block.
		const info = match[3].trim().split(/\s+/);
		const body: string[] = [];
		let closed = false;
		for (let i = 1; i < lines.length; i++) {
			const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
			if (end && end[1][0] === match[2][0] && end[1].length >= match[2].length) { closed = true; break; }
			body.push(lines[i].replace(new RegExp(`^ {0,${match[1].length}}`), ""));
		}
		if (!closed && body.at(-1) === "" && raw.endsWith("\n")) body.pop();
		// Match Pi's trimPartialClosingFences: never paint/copy a streamed partial delimiter.
		const last = body.at(-1);
		if (!closed && last && last.length < match[2].length && last === match[2][0].repeat(last.length)) body.pop();
		result.push({ code: body.join("\n"), language: info[0] || "text", path: info.find((part) => part.startsWith("path="))?.slice(5), open: !closed });
	}
	return result;
}

export function numberlessDiff(diff: string): string {
	return diff.split("\n").map((line) => line.replace(/^([+\- ])\s*\d+ /, "$1 ")).join("\n");
}

function track(component: Component) {
	const state = runtime();
	if (!state) return;
	state.components.add(new WeakRef(component));
	if (state.components.size > 1000) {
		for (const ref of state.components) if (!ref.deref()) state.components.delete(ref);
		// This is a redraw index, not transcript storage.
		while (state.components.size > 1000) state.components.delete(state.components.values().next().value!);
	}
}

const CODE_BLOCK_OPACITY = 0.15;
const terminalDefaults = new Map<string, Theme>();
function codeBackground(theme: Theme): string {
	const key = `${theme.appearance}:${theme.getColorMode()}`;
	let defaults = terminalDefaults.get(key);
	if (!defaults) {
		const foregrounds = Object.fromEntries(Object.keys(theme.colors).map((token) => [token, ""])) as ConstructorParameters<typeof Theme>[0];
		defaults = new Theme(foregrounds, {
			selectedBg: "", searchMatchBg: "", userMessageBg: "", customMessageBg: "",
			toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
		}, theme.getColorMode(), { appearance: theme.appearance });
		terminalDefaults.set(key, defaults);
	}
	// An opaque 15% tint blended over Pi's reported terminal background, not alpha.
	const tint = mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb");
	return backgroundAnsi(mixColors(defaults.colors.toolPendingBg, tint, CODE_BLOCK_OPACITY, "srgb"), theme.getColorMode());
}

/** Restore the surface after resets without discarding intentional nested ANSI colors. */
function fillLine(line: string, background: string): string {
	if (!background) return line;
	return background + line.replace(/\x1b\[([\d;]*)m/g, (sequence, parameters: string) => {
		const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
		let restore = false;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 38 || code === 48 || code === 58) {
				if (code === 48) restore = false;
				i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
			} else if (code === 0 || code === 49) restore = true;
			else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) restore = false;
		}
		return sequence + (restore ? background : "");
	}) + "\x1b[49m";
}

/** Ownership exists only during this synchronous parent render, never as a color allowlist. */
export function renderWithCodeBlockPaint(render: () => string[]): { lines: string[]; ownedRows: Map<string, string> } {
	const state = runtime();
	const ownedRows = new Map<string, string>();
	if (!state) return { lines: render(), ownedRows };
	const previous = state.paintScope;
	state.paintScope = ownedRows;
	try { return { lines: render(), ownedRows }; }
	finally { state.paintScope = previous; }
}

/** A bordered code surface. The copy payload is always source, never painted lines. */
export class CodeBlock implements Component {
	private copyStart = -1;
	private copyEnd = -1;
	private feedback: { copied?: boolean; pending?: boolean };
	constructor(private body: Component, readonly code: string, private language: string,
		private status: string, private path?: string, private redraw: () => void = () => {},
		private theme?: Theme, feedback: { copied?: boolean; pending?: boolean } = {}) { this.feedback = feedback; track(this); }
	private palette() { return this.theme ?? runtime()?.palette?.(); }
	private border(text: string) { return this.palette()?.fg("borderMuted", text) ?? getMarkdownTheme().codeBlockBorder(text); }
	private muted(text: string) { return this.palette()?.fg("muted", text) ?? getMarkdownTheme().codeBlockBorder(text); }
	render(width: number): string[] {
		width = Math.max(0, width);
		this.copyStart = this.copyEnd = -1;
		if (width < 16) return this.body.render(width).map((line) => truncateToWidth(line, width));
		const inner = width - 4;
		const action = this.feedback.pending ? "[Copying]" : this.feedback.copied ? "[Copied]" : "[Copy]";
		const left = `${runtime()?.showPath && this.path ? `${label(this.path)}  ` : ""}${label(this.language || "text")}`;
		// ▕ <label> <top-edge rule> <status/action> ▏ : six fixed columns.
		const headerWidth = width - 6;
		const right = `${headerWidth >= 26 ? `${label(this.status)}  ` : ""}${action}`;
		const heading = truncateToWidth(left, Math.max(0, headerWidth - visibleWidth(right) - 1));
		// Overline sits at the top edge of spaces, not halfway through a glyph cell.
		const topRule = (columns: number) => this.border("\x1b[59;53m" + " ".repeat(columns) + "\x1b[55m");
		const ruleWidth = Math.max(0, headerWidth - visibleWidth(heading) - visibleWidth(right));
		const headerContent = topRule(1) + this.muted(heading) + topRule(ruleWidth + 2) + this.muted(right) + topRule(1);
		this.copyEnd = width - 2;
		this.copyStart = this.copyEnd - action.length;
		const palette = this.palette();
		const background = palette ? codeBackground(palette) : "";
		const frame = (content: string) => this.border("▕") + fillLine(content, background) + this.border("▏");
		const row = (line: string) => frame(" " + line + background + " ".repeat(Math.max(0, inner - visibleWidth(line)) + 1));
		const lines = this.body.render(inner).flatMap((line) => wrapTextWithAnsi(line, inner));
		// The bottom cap is an unpainted row: the fill above meets its top-edge stroke.
		const result = [frame(headerContent), ...lines.map(row), " " + topRule(width - 2) + " "];
		for (const line of result) runtime()?.paintScope?.set(line.trim(), line);
		return result;
	}
	invalidate() { this.body.invalidate(); }
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= this.copyStart && event.x < this.copyEnd && this.copyStart >= 0) {
			void this.copy().catch(() => {});
			return { handled: true };
		}
		if (event.y >= 1 && event.y < event.height - 1 && event.x >= 2 && event.x < event.width - 2) {
			return this.body.handleMouse?.({ ...event, x: event.x - 2, y: event.y - 1, width: event.width - 4, height: event.height - 2 });
		}
	}
	async copy() {
		const state = runtime();
		if (!state || this.feedback.pending) return;
		const redraw = () => { if (runtime() === state) { try { this.redraw(); } catch { /* A replaced session cannot be redrawn. */ } } };
		const notify = (text: string, error = false) => { if (runtime() === state) { try { state.notify(text, error); } catch { /* Context may be invalidated during reload. */ } } };
		this.feedback.pending = true;
		redraw();
		try {
			await state.copy(this.code);
			this.feedback.copied = true;
			notify("Code copied");
		} catch (error) { notify(String(error), true); }
		finally { this.feedback.pending = false; redraw(); }
	}
}

interface Token { type: string; text?: string; lang?: string; raw?: string }
interface MarkdownInternals {
	text: string; paddingX: number; paddingY: number; cachedLines?: string[]; cachedWidth?: number; cachedText?: string;
	options: { transform?: (text: string, width: number) => string };
	render(width: number): string[];
	renderToken(token: Token, width: number, next?: string, style?: unknown): string[];
	invalidate(): void;
	handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}
interface MarkdownState {
	depth: number;
	fences: Fence[];
	blocks: { panel: CodeBlock; header: string; y: number }[];
	context?: { messageType: string; isStreaming: boolean };
	revision: number;
	feedback: Map<string, { copied?: boolean; pending?: boolean }>;
}

/** Only private boundary: Pi 1.0.4's Markdown token adapter; all prose stays native. */
export function installMarkdownAdapter(): { restore: () => void; context: (context: MarkdownState["context"], source: string) => void } | undefined {
	const proto = Markdown.prototype as unknown as MarkdownInternals;
	const originalRender = proto.render, originalToken = proto.renderToken, originalMouse = proto.handleMouse;
	// Shape/signature guard: unknown Pi renderers must keep rendering natively.
	if (typeof originalToken !== "function" || typeof originalRender !== "function"
		|| !/replace\(\s*\/\\t\/g\s*,\s*["'] {3}["']\s*\)/.test(String(originalRender))
		|| !String(originalRender).includes("cachedTokens") || !/case\s*["']code["']/.test(String(originalToken))) return;
	const states = new WeakMap<object, MarkdownState>();
	let active: MarkdownState | undefined;
	function render(this: MarkdownInternals, width: number) {
		let state = states.get(this);
		if (!state) { state = { depth: 0, fences: [], blocks: [], revision: runtime()?.revision ?? 0, feedback: new Map() }; states.set(this, state); track(this as unknown as Component); }
		if (state.revision !== runtime()?.revision) { this.invalidate(); state.revision = runtime()?.revision ?? 0; }
		const parent = active;
		active = state;
		const cached = this.cachedLines && this.cachedWidth === width && this.cachedText === this.text;
		if (!cached) { state.blocks = []; state.fences = []; state.context = undefined; }
		try {
			// Native Markdown's horizontal padding can exceed very narrow viewports.
			const lines = originalRender.call(this, width).map((line) => visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width)) : line);
			let from = 0;
			for (const block of state.blocks) {
				block.y = lines.findIndex((line, index) => index >= from && line.includes(block.header));
				if (block.y >= 0) from = block.y + 1;
			}
			return lines;
		} finally { active = parent; }
	}
	function token(this: MarkdownInternals, item: Token, width: number, next?: string, style?: unknown) {
		const state = active;
		if (!extracting && state && state.depth === 0 && item.type === "code" && state.context?.messageType === "assistant" && width >= 16) {
			const index = state.fences.findIndex((fence) => fence.code.replace(/\t/g, "   ") === item.text && (fence.language === (item.lang?.split(/\s+/)[0] || "text")));
			const fence = state.fences[index];
			if (fence) {
				state.fences.splice(index, 1);
				const theme = getMarkdownTheme();
				const painted = [...(theme.highlightCode?.(fence.code.replace(/\t/g, "   "), fence.language) ?? fence.code.split("\n").map(theme.codeBlock))];
				if (!painted.length) painted.push("");
				if (state.context.isStreaming && fence.open) painted[painted.length - 1] = (painted.at(-1) ?? "") + theme.codeBlockBorder("▌");
				const body = new Text(painted.join("\n"), 0, 0);
				const identity = `${state.blocks.length}:${fence.language}:${fence.code}`;
				const feedback = state.feedback.get(identity) ?? {};
				state.feedback.set(identity, feedback);
				while (state.feedback.size > 32) state.feedback.delete(state.feedback.keys().next().value!);
				const panel = new CodeBlock(body, fence.code, fence.language,
					state.context.isStreaming && fence.open ? "● Generating" : "✓ Complete", fence.path, () => this.invalidate(), undefined, feedback);
				const lines = panel.render(width);
				state.blocks.push({ panel, header: lines[0], y: -1 });
				if (next && next !== "space") lines.push("");
				return lines;
			}
		}
		if (state) state.depth++;
		try { return originalToken.call(this, item, width, next, style); }
		finally { if (state) state.depth--; }
	}
	function mouse(this: MarkdownInternals, event: TuiMouseEvent) {
		const state = states.get(this);
		for (const block of state?.blocks ?? []) {
			if (block.y >= 0 && event.y === block.y) {
				const result = block.panel.handleMouse({ ...event, x: event.x - this.paddingX, y: 0, width: event.width - this.paddingX * 2 });
				if (result) return result;
			}
		}
		return originalMouse?.call(this, event);
	}
	proto.render = render; proto.renderToken = token; proto.handleMouse = mouse;
	return {
		context(context, source) { if (active) { active.context = context; active.fences = fences(source); } },
		restore() {
			// Do not clobber an adapter installed by another extension afterwards.
			if (proto.render === render) proto.render = originalRender;
			if (proto.renderToken === token) proto.renderToken = originalToken;
			if (proto.handleMouse === mouse) {
				if (originalMouse) proto.handleMouse = originalMouse;
				else delete proto.handleMouse;
			}
		},
	};
}

/** Called by compact-tools after native rendering, preserving plugin/ANSI/diff output. */
export function toolCodeBlock(body: Component, code: string, tool: string, context: ToolRenderContext, theme: Theme): Component {
	if (!runtime()) return body;
	const args = context.args as Record<string, unknown>;
	const path = args.path ?? args.file_path;
	const language = tool === "bash" ? "shell" : tool === "edit" ? "diff" : typeof path === "string" ? getLanguageFromPath(path) ?? "text" : "text";
	const feedbacks: Map<string, { copied?: boolean; pending?: boolean }> = context.state.codeBlockFeedback ??= new Map();
	const feedback = feedbacks.get(code) ?? {};
	feedbacks.set(code, feedback);
	while (feedbacks.size > 8) feedbacks.delete(feedbacks.keys().next().value!);
	return new CodeBlock(body, code, language, context.isError ? "✕ Error" : context.isPartial ? "● Running" : "✓ Done", typeof path === "string" ? path : undefined, context.invalidate, theme, feedback);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("code-block-path", { description: "Show explicit file paths in code-block headers", type: "boolean", default: false });
	let adapter: ReturnType<typeof installMarkdownAdapter>;
	let owned: Runtime | undefined;
	function stop() {
		adapter?.restore(); adapter = undefined;
		if (globals[KEY] === owned) delete globals[KEY];
		owned = undefined;
	}
	pi.registerMarkdownTransformer((source, context) => { adapter?.context(context, source); return source; });
	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		owned = { showPath: pi.getFlag("code-block-path") === true, copy: copyToClipboard,
			notify: (text, error) => ctx.ui.notify(text, error ? "error" : "info"), components: new Set(), revision: 0, palette: () => ctx.ui.theme };
		globals[KEY] = owned;
		adapter = installMarkdownAdapter();
		if (!adapter) ctx.ui.notify("Code-block message adapter unsupported by this Pi version; native message rendering retained.", "warning");
	});
	pi.on("session_shutdown", stop);
	pi.registerCommand("codeblock-path", {
		description: "Toggle optional code-block paths: /codeblock-path [on|off]",
		handler: async (args, ctx) => {
			const state = runtime();
			if (ctx.mode !== "tui" || !state) return;
			const value = args.trim();
			if (value && value !== "on" && value !== "off") { ctx.ui.notify("Usage: /codeblock-path [on|off]", "warning"); return; }
			state.showPath = value ? value === "on" : !state.showPath;
			state.revision++;
			for (const ref of state.components) ref.deref()?.invalidate();
			ctx.ui.notify(`Code-block paths ${state.showPath ? "shown" : "hidden"}`, "info");
		},
	});
	pi.registerCommand("code-copy", {
		description: "Copy source code from a message/tool block on the current session branch",
		handler: async (_args, ctx) => {
			const state = runtime();
			if (ctx.mode !== "tui" || !state) return;
			const blocks: { name: string; code: string }[] = [];
			const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				if (message.role === "assistant") {
					for (const part of message.content) {
						if (part.type === "text") for (const fence of fences(part.text)) blocks.push({ name: `${fence.language}: ${label(fence.code.split("\n")[0]).slice(0, 60)}`, code: fence.code });
						if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: part.arguments });
					}
				} else if (message.role === "toolResult") {
					const call = calls.get(message.toolCallId);
					if (!call || !["read", "bash", "write", "edit"].includes(call.name)) continue;
					const details = message.details as { diff?: string } | undefined;
					const code = call.name === "write" && !message.isError && typeof call.arguments.content === "string" ? call.arguments.content
						: call.name === "edit" && !message.isError && typeof details?.diff === "string" ? numberlessDiff(details.diff)
						: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					if (code) blocks.push({ name: `${call.name}: ${label(code.split("\n")[0]).slice(0, 60)}`, code });
				}
			}
			if (!blocks.length) { ctx.ui.notify("No code blocks on this branch", "info"); return; }
			const choices = blocks.map((block, index) => `${index + 1}. ${block.name}`).reverse();
			const selected = await ctx.ui.select("Copy code block (newest first)", choices);
			if (!selected || runtime() !== state) return;
			const block = blocks[Number(selected.split(".")[0]) - 1];
			try { await state.copy(block.code); if (runtime() === state) state.notify("Code copied"); }
			catch (error) { if (runtime() === state) state.notify(String(error), true); }
		},
	});
}
