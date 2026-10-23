import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// pi-pretty's claudecode tool style installs its prompt editor with `boxed = false`,
// which drops the rounded frame (plain rules) and keeps `❯` flush left. This rebuilds
// the same editor class with `boxed = true`: corners, the author's inner padding, and
// the prompt sitting inside the box. If pi-pretty's module cannot be loaded, it falls
// back to post-processing the border lines of whatever factory is installed.

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

// Factories we produced. A WeakSet keeps us from touching a factory we do not own.
const ours = new WeakSet<EditorFactory>();
let baseline: EditorFactory | undefined;
/** Owner intent; kept apart from install state so "off" cannot be undone by a turn. */
let enabled = true;
let boxedFactory: EditorFactory | undefined;
let boxedFactoryResolved = false;

function editorUI(ctx: ExtensionContext): EditorUI {
	return ctx.ui as unknown as EditorUI;
}

const PROMPT_EDITOR_ENTRY = join(
	homedir(), ".pi", "agent", "extensions",
	"pi-pretty", "src", "prompt-editor.ts",
);

/**
 * The same editor pi-pretty builds, but boxed. Returns undefined when the package
 * (or its internal shape) is not what we expect — the caller then falls back.
 */
async function resolveBoxedFactory(pi: ExtensionAPI, ctx: ExtensionContext): Promise<EditorFactory | undefined> {
	if (boxedFactoryResolved) return boxedFactory;
	boxedFactoryResolved = true;
	try {
		const mod = (await import(pathToFileURL(PROMPT_EDITOR_ENTRY).href)) as {
			createPromptEditorClass?: (base: unknown, paintIcon: (icon: string) => string, boxed: boolean) => new (...args: unknown[]) => EditorLike;
		};
		if (typeof mod.createPromptEditorClass !== "function") return undefined;
		// Read the theme and thinking level at paint time, not at install time. The
		// factory is resolved once (boxedFactoryResolved), so capturing here would pin
		// the icon to whatever level was active on the first session_start and never
		// follow /thinking changes until pi restarts.
		const liveTheme = () => (ctx.ui as unknown as {
			theme?: { getThinkingBorderColor?: (level: string) => (icon: string) => string; fg?: (token: string, text: string) => string };
		}).theme;
		const liveLevel = (): string => {
			try {
				return pi.getThinkingLevel() ?? "off";
			} catch {
				return (ctx as unknown as { thinkingLevel?: string }).thinkingLevel ?? "off";
			}
		};
		const paintIcon = (icon: string): string => {
			try {
				const theme = liveTheme();
				if (theme && typeof theme.getThinkingBorderColor === "function") return theme.getThinkingBorderColor(liveLevel())(icon);
				if (theme && typeof theme.fg === "function") return theme.fg("thinkingText", icon);
			} catch {
				// Fall through to the uncoloured icon.
			}
			return icon;
		};
		const PromptEditor = mod.createPromptEditorClass(CustomEditor, paintIcon, true);
		boxedFactory = ((...args: unknown[]) => new PromptEditor(...args)) as EditorFactory;
		ours.add(boxedFactory);
		return boxedFactory;
	} catch {
		return undefined;
	}
}

function round(editor: EditorLike, line: unknown, width: number, left: string, right: string): string {
	if (typeof line !== "string") return "";
	if (width < 2) return line;
	if (visibleWidth(line) !== width) return line;
	const paint = typeof editor.borderColor === "function" ? (text: string) => editor.borderColor!(text) : (text: string) => text;
	return `${paint(left)}${sliceByColumn(line, 1, width - 2, true)}${paint(right)}`;
}

/** Fallback: keep the installed editor, decorate the two border lines. */
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

type EnsureResult = "boxed" | "rounded" | "already" | "unsupported";

async function ensure(pi: ExtensionAPI, ctx: ExtensionContext): Promise<EnsureResult> {
	if (ctx.mode !== "tui") return "unsupported";
	try {
		const ui = editorUI(ctx);
		if (typeof ui.getEditorComponent !== "function" || typeof ui.setEditorComponent !== "function") return "unsupported";
		const current = ui.getEditorComponent();
		if (current && ours.has(current)) return "already";
		if (current) baseline = current;

		const boxed = await resolveBoxedFactory(pi, ctx);
		if (boxed) {
			ui.setEditorComponent(boxed);
			return "boxed";
		}
		if (!current) return "unsupported";
		ui.setEditorComponent(wrapFactory(current));
		return "rounded";
	} catch {
		return "unsupported";
	}
}

function restore(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui") return false;
	try {
		const ui = editorUI(ctx);
		if (typeof ui.setEditorComponent !== "function") return false;
		const current = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;
		// A newer foreign factory appeared after our wrap: adopt it, do not clobber it.
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
	// extension order is not guaranteed, so retry briefly; `ensure` is idempotent and
	// `agent_start` keeps our factory attached if theirs lands later.
	const scheduleRetries = (ctx: ExtensionContext): void => {
		void ensure(pi, ctx);
		for (const delay of [50, 200, 600, 1500]) {
			const timer = setTimeout(() => {
				if (enabled) void ensure(pi, ctx);
			}, delay);
			if (typeof timer.unref === "function") timer.unref();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) scheduleRetries(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (enabled) await ensure(pi, ctx);
	});

	pi.registerCommand("input-border", {
		description: "Boxed input with the prompt inside, on top of pi-pretty's claudecode style (on|off)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const action = args.trim().toLowerCase();

			if (action === "off") {
				enabled = false;
				const undone = restore(ctx);
				ctx.ui.notify(undone ? "Input box back to pi-pretty's plain rules" : "Nothing to undo: the box is not ours", undone ? "info" : "warning");
				return;
			}

			if (action === "on") {
				enabled = true;
				const result = await ensure(pi, ctx);
				if (result === "unsupported") ctx.ui.notify("No editor factory to take over yet — try again once the editor exists", "warning");
				else if (result === "boxed") ctx.ui.notify("Boxed input installed: frame with the prompt inside", "info");
				else ctx.ui.notify("Frame drawn, but pi-pretty's module was not loadable — prompt stays flush left", "warning");
				return;
			}

			ctx.ui.notify("Usage: /input-border on|off", "info");
		},
	});
}
