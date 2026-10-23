import type { ResolvedPalette, WorkingIndicatorMode } from "./types.js";

/**
 * Shimmer frame construction.
 *
 * Ports the sweep from oh-my-pi's `modes/theme/shimmer.ts`: the band is
 * discretized into one pre-rendered frame per position and cycled at
 * 1000/30 ms, so it travels 30 cells/second — omp's exact speed.
 *
 * Every frame is a finished ANSI string. That is the whole design constraint of
 * this extension: the host renderer only knows "one spinner + one colour", so a
 * per-cell gradient can only exist if it was baked before the host sees it.
 */

// ─── Sweep tunables (oh-my-pi shimmer.ts) ────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

/** One cell per frame at 33ms = omp's 30 cells/second band speed. */
export const WORKING_INTERVAL_MS = Math.round(1000 / 30);

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Spinner glyph advances every N frames (~99ms ≈ pi's default 80ms cadence). */
const SPINNER_STEP = 3;

const RESET_FG = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";
const ITALIC_OPEN = "\x1b[3m";
const ITALIC_CLOSE = "\x1b[23m";

// ─── Frame building ──────────────────────────────────────────────────────────

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(index: number, pos: number): number {
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * text with a quadratic-decay trail behind it (oh-my-pi shimmer.ts).
 */
function kittIntensity(index: number, head: number, goingRight: boolean): number {
	const delta = index - head;
	if (Math.abs(delta) <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

/** UTF-16 [start, end] index pairs per code point (surrogate-pair safe). */
function codePointRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				ranges.push([i, i + 2]);
				i += 2;
				continue;
			}
		}
		ranges.push([i, i + 1]);
		i += 1;
	}
	return ranges;
}

export interface WorkingFrameOptions {
	mode: WorkingIndicatorMode;
	/** Resolved ANSI open sequences per tier. */
	ansi: ResolvedPalette;
	bold?: boolean;
	spinner?: boolean;
	/** Spinner glyph color; defaults to `ansi.low` (omp tints it with the dim accent). */
	spinnerColor?: string;
	/** Wrap every frame in italic (pi's hidden-thinking label is italic). */
	italic?: boolean;
	/** @deprecated Retained for call-site compatibility; suffixes are not rendered. */
	hint?: string;
	intervalMs?: number;
}

/**
 * Build the frame list for the working row: one full sweep per phrase, in
 * order, with the spinner phase running continuously across chapter
 * boundaries. Same-tier runs share one ANSI pair (omp's run coalescing).
 */
export function buildWorkingFrames(
	texts: string[],
	options: WorkingFrameOptions,
): { frames: string[]; intervalMs: number } {
	const intervalMs = options.intervalMs ?? WORKING_INTERVAL_MS;
	const bold = options.bold ?? true;
	const withSpinner = options.spinner ?? true;
	const spinnerColor = options.spinnerColor ?? options.ansi.low;
	const highOpen = bold ? `${BOLD_OPEN}${options.ansi.high}` : options.ansi.high;
	const highClose = bold ? `${BOLD_CLOSE}${RESET_FG}` : RESET_FG;
	const seq: Record<Tier, { open: string; close: string }> = {
		low: { open: options.ansi.low, close: RESET_FG },
		mid: { open: options.ansi.mid, close: RESET_FG },
		high: { open: highOpen, close: highClose },
	};

	const spinnerPrefix = (frameIndex: number): string => {
		if (!withSpinner) return "";
		const glyph = SPINNER_FRAMES[Math.floor(frameIndex / SPINNER_STEP) % SPINNER_FRAMES.length] ?? "";
		return `${spinnerColor}${glyph}${RESET_FG} `;
	};

	const paintFrame = (text: string, ranges: Array<[number, number]>, tiers: Tier[]): string => {
		const total = ranges.length;
		let out = "";
		let runStart = 0;
		let runTier: Tier | null = null;
		const flush = (endIndex: number): void => {
			if (runTier === null || endIndex <= runStart) return;
			const s = seq[runTier];
			out += `${s.open}${text.slice(ranges[runStart][0], ranges[endIndex - 1][1])}${s.close}`;
		};
		for (let i = 0; i < total; i++) {
			if (tiers[i] !== runTier) {
				flush(i);
				runTier = tiers[i] ?? null;
				runStart = i;
			}
		}
		flush(total);
		return options.italic ? `${ITALIC_OPEN}${out}${ITALIC_CLOSE}` : out;
	};

	const frames: string[] = [];
	let spinnerIndex = 0;

	for (const raw of texts) {
		const text = raw.trim();
		const ranges = codePointRanges(text);
		const total = ranges.length;
		if (total === 0) continue;

		if (options.mode === "static") {
			// Static mode: one unanimated frame — only the first phrase renders.
			frames.push(
				`${spinnerPrefix(spinnerIndex++)}${paintFrame(
					text,
					ranges,
					Array.from({ length: total }, () => "mid" as Tier),
				)}`,
			);
			return { frames, intervalMs };
		}

		if (options.mode === "kitt") {
			const range = total - 1;
			if (range <= 0) {
				frames.push(
					`${spinnerPrefix(spinnerIndex++)}${paintFrame(
						text,
						ranges,
						Array.from({ length: total }, () => "high" as Tier),
					)}`,
				);
				continue;
			}
			const cycleCells = 2 * range;
			for (let sweep = 0; sweep < cycleCells; sweep++) {
				const goingRight = sweep < range;
				const head = goingRight ? sweep : cycleCells - sweep;
				const tiers = Array.from({ length: total }, (_, i) => tierFor(kittIntensity(i, head, goingRight)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}`);
			}
		} else {
			const period = total + CLASSIC_PADDING * 2;
			for (let pos = 0; pos < period; pos++) {
				const tiers = Array.from({ length: total }, (_, i) => tierFor(classicIntensity(i, pos)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}`);
			}
		}
	}
	return { frames, intervalMs };
}

/** @deprecated The working row no longer displays token stats. */
export function workingTokens(message: unknown): number {
	const usage = (message as { usage?: { output?: unknown } } | undefined)?.usage;
	const output = Number(usage?.output);
	if (Number.isFinite(output) && output > 0) return Math.round(output);
	const content = (message as { content?: Array<{ type?: string; text?: unknown; thinking?: unknown }> } | undefined)
		?.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block?.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
	}
	return Math.round(chars / 4);
}
