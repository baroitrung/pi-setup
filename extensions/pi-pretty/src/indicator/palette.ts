/**
 * Palette to ANSI resolution: a pi theme token name, a `#rrggbb` hex, or a
 * built-in fallback.
 */

import { FG_BLUE, FG_DIM, FG_MUTED } from "../config.js";
import { hexToAnsiFg } from "../session-color.js";
import type { WorkingIndicatorPalette } from "./settings.js";
import type { ResolvedPalette, ThemeAnsiSource } from "./types.js";

export type { ResolvedPalette, ThemeAnsiSource };

// ─── Palette resolution ──────────────────────────────────────────────────────

/** Tier colors as raw ANSI open sequences. */
/** Fallback for pi's thinkingText tier when no theme is available. */
export const FG_THINKING_FALLBACK = "\x1b[38;2;148;148;184m";

export function colorToAnsi(value: string, theme: ThemeAnsiSource | undefined, fallback: string): string {
	const hex = hexToAnsiFg(value);
	if (hex) return hex;
	try {
		// Pi's ThemeColor is a closed TS union, but getFgAnsi accepts any registered
		// theme color at runtime; unknown names throw or return non-ANSI garbage,
		// both handled below.
		const getFgAnsi = theme?.getFgAnsi as ((name: string) => string) | undefined;
		const viaTheme = getFgAnsi?.(value);
		if (viaTheme?.startsWith("\x1b[")) return viaTheme;
	} catch {
		// Unknown theme color name: fall through to the built-in constant.
	}
	return fallback;
}

/**
 * Resolve tier colors to ANSI open sequences. `#rrggbb` wins, then the active
 * pi theme (`getFgAnsi`), then pi-pretty's built-in constants.
 */
export function resolvePaletteAnsi(palette: WorkingIndicatorPalette, theme?: ThemeAnsiSource): ResolvedPalette {
	return {
		low: colorToAnsi(palette.low, theme, FG_DIM),
		mid: colorToAnsi(palette.mid, theme, FG_MUTED),
		high: colorToAnsi(palette.high, theme, FG_BLUE),
	};
}
