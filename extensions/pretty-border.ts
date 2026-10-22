import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

// pi-pretty's claudecode tool style gives the input box plain rules instead of a
// rounded frame (`createPromptEditorClass(..., !claudeStyle)` → boxed = false).
// This puts the corners back without touching pi-pretty: it wraps whatever editor
// factory is installed and rounds the border lines it produces.

type EditorLike = {
	borderColor?: (text: string) => string;
	renderTopBorder?: (width: number, hiddenLineCount: number) => string;
	renderBottomBorder?: (width: number, hiddenLineCount: number) => string;
};

type EditorFactory = (...args: unknown[]) => EditorLike;

type EditorUI = {
	getEditorComponent?: () => EditorFactory | undefined;
	setEditorComponent?: (factory: EditorFactory) => void;
};

const TOP = ["╭", "╮"] as const;
const BOTTOM = ["╰", "╯"] as const;

// Factories we produced. A WeakSet keeps us from mutating a factory we do not own
// (a frozen object would throw on a property assignment). A reload starts with an
// empty set, which costs at most one harmless re-wrap.
const ours = new WeakSet<EditorFactory>();

/** The factory to return to on `/input-border off`; always the latest foreign one. */
let baseline: EditorFactory | undefined;
/** Owner intent. Kept separate from install state so "off" cannot be undone by a later turn. */
let enabled = true;

function editorUI(ctx: ExtensionContext): EditorUI {
	return ctx.ui as unknown as EditorUI;
}

function round(editor: EditorLike, line: unknown, width: number, left: string, right: string): string {
	if (typeof line !== "string") return "";
	if (width < 2) return line;
	// Only touch lines the editor actually drew at full width; a short line means the
	// host is hiding the border itself, and corners would be a lie.
	if (visibleWidth(line) !== width) return line;
	const paint = typeof editor.borderColor === "function" ? (text: string) => editor.borderColor!(text) : (text: string) => text;
	return `${paint(left)}${sliceByColumn(line, 1, width - 2, true)}${paint(right)}`;
}

function wrapFactory(current: EditorFactory): EditorFactory {
	const wrapped: EditorFactory = (...args) => {
		const editor = current(...args);
		const top = editor.renderTopBorder?.bind(editor);
		const bottom = editor.renderBottomBorder?.bind(editor);
		if (typeof top !== "function" || typeof bottom !== "function") return editor;

		editor.renderTopBorder = (width, hidden) => round(editor, top(width, hidden), width, TOP[0], TOP[1]);
		editor.renderBottomBorder = (width, hidden) => round(editor, bottom(width, hidden), width, BOTTOM[0], BOTTOM[1]);
		return editor;
	};
	ours.add(wrapped);
	return wrapped;
}

type EnsureResult = "wrapped" | "already" | "unsupported";

/** Wrap the current factory. Safe to call every turn: it is a WeakSet hit when done. */
function ensure(ctx: ExtensionContext): EnsureResult {
	if (ctx.mode !== "tui") return "unsupported";
	try {
		const ui = editorUI(ctx);
		if (typeof ui.getEditorComponent !== "function" || typeof ui.setEditorComponent !== "function") return "unsupported";
		const current = ui.getEditorComponent();
		if (!current) return "unsupported";
		if (ours.has(current)) return "already";
		baseline = current;
		ui.setEditorComponent(wrapFactory(current));
		return "wrapped";
	} catch {
		return "unsupported";
	}
}

/** Put the host factory back. Reports whether there was anything to undo. */
function restore(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui") return false;
	try {
		const ui = editorUI(ctx);
		if (typeof ui.setEditorComponent !== "function") return false;
		const current = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;
		// Someone installed a new factory after our last wrap: adopt it as the baseline
		// instead of clobbering it with a stale one, and report nothing left to undo.
		if (current && !ours.has(current)) {
			baseline = current;
			return false;
		}
		if (!baseline) return false;
		ui.setEditorComponent(baseline);
		baseline = undefined;
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// pi-pretty installs its prompt editor in its own session_start handler and
	// extension order is not guaranteed, so retry briefly: whichever side lands last,
	// `ensure` is idempotent and `agent_start` keeps the wrapper attached afterwards.
	const scheduleRetries = (ctx: ExtensionContext): void => {
		ensure(ctx);
		for (const delay of [50, 200, 600, 1500]) {
			const timer = setTimeout(() => {
				if (enabled) ensure(ctx);
			}, delay);
			if (typeof timer.unref === "function") timer.unref();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;
		scheduleRetries(ctx);
	});

	// A replacement factory is only detected here, so this runs unconditionally while
	// the owner wants the border — not just until the first successful wrap.
	pi.on("agent_start", async (_event, ctx) => {
		if (enabled) ensure(ctx);
	});

	pi.registerCommand("input-border", {
		description: "Rounded input border on top of pi-pretty's claudecode style (on|off)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase();

			if (action === "off") {
				enabled = false;
				const undone = restore(ctx);
				ctx.ui.notify(undone ? "Input border back to pi-pretty's plain rules" : "Nothing to undo: the border is not wrapped", undone ? "info" : "warning");
				return;
			}

			if (action === "on") {
				enabled = true;
				const result = ensure(ctx);
				if (result === "unsupported") ctx.ui.notify("No editor factory to wrap yet — try again after the editor is installed", "warning");
				else ctx.ui.notify(result === "wrapped" ? "Rounded input border installed" : "Rounded input border already active", "info");
				return;
			}

			ctx.ui.notify("Usage: /input-border on|off", "info");
		},
	});
}
