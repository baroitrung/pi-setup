import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	foregroundAnsi,
	getTerminalColorMode,
	mixColors,
	parseColor,
	type Color,
} from "@earendil-works/pi-tui";

// Same stops as custom-banner.ts so the loader reads as part of the header.
const PALETTE: Color[] = ["#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#fb923c"].map(parseColor);
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const FG_RESET = "\x1b[39m";

const WORKING_MESSAGE = "Working…";
const THINKING_LABEL = "Thinking…";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function colorAt(position: number): Color {
	const t = Math.min(1, Math.max(0, position)) * (PALETTE.length - 1);
	const stop = Math.min(Math.floor(t), PALETTE.length - 2);
	return mixColors(PALETTE[stop], PALETTE[stop + 1], t - stop, "srgb");
}

/**
 * Paint `text` with the banner gradient, one truecolor sequence per glyph.
 * Spaces stay unpainted so trailing resets never colour the terminal padding.
 */
function paint(text: string): string {
	const chars = Array.from(text);
	const mode = getTerminalColorMode();
	const span = Math.max(1, chars.length - 1);
	return chars
		.map((char, index) => {
			if (char === " ") return char;
			const ansi = foregroundAnsi(colorAt(index / span), mode);
			return `${BOLD_ON}${ansi}${char}${FG_RESET}${BOLD_OFF}`;
		})
		.join("");
}

/** Frames are rendered verbatim, so each glyph carries its own gradient step. */
function spinnerFrames(): string[] {
	const mode = getTerminalColorMode();
	const last = Math.max(1, SPINNER.length - 1);
	return SPINNER.map((glyph, index) => {
		const ansi = foregroundAnsi(colorAt(index / last), mode);
		return `${BOLD_ON}${ansi}${glyph}${FG_RESET}${BOLD_OFF}`;
	});
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

function applyGradient(ctx: ExtensionContext): void {
	if (!isTui(ctx)) return;
	ctx.ui.setWorkingIndicator({ frames: spinnerFrames(), intervalMs: 100 });
	ctx.ui.setWorkingMessage(paint(WORKING_MESSAGE));
	ctx.ui.setHiddenThinkingLabel(paint(THINKING_LABEL));
}

function restoreDefault(ctx: ExtensionContext): void {
	if (!isTui(ctx)) return;
	ctx.ui.setWorkingIndicator(undefined);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setHiddenThinkingLabel(undefined);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyGradient(ctx);
	});

	// Pi clears the working message after every run, so re-arm it before the loader
	// is rebuilt; the thinking label is only set on session start.
	pi.on("agent_start", async (_event, ctx) => {
		if (!isTui(ctx)) return;
		ctx.ui.setWorkingMessage(paint(WORKING_MESSAGE));
	});

	pi.registerCommand("gradient-working", {
		description: "Use the banner gradient for working/thinking labels (on|off)",
		handler: async (args, ctx) => {
			if (!isTui(ctx)) return;
			if (args.trim().toLowerCase() === "off") {
				restoreDefault(ctx);
				ctx.ui.notify("Working/thinking labels back to theme colours", "info");
				return;
			}
			if (args.trim().toLowerCase() === "on") {
				applyGradient(ctx);
				ctx.ui.notify("Working/thinking labels use the banner gradient", "info");
				return;
			}
			ctx.ui.notify("Usage: /gradient-working on|off", "info");
		},
	});
}
