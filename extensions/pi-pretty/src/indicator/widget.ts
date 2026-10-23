/**
 * Legacy fallback for hosts without Pi's embedded working-status API: a
 * zero-padding row rendered above the editor.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { WORKING_INTERVAL_MS } from "./frames.js";
import type { WidgetTuiLike } from "./types.js";

export type { WidgetTuiLike };

// ─── Widget ──────────────────────────────────────────────────────────────────

/**
 * Zero-padding working-row component. The host renders whatever `render()`
 * returns with no margins, so the legacy widget row sits flush-left without
 * relying on the host loader's padding.
 */
export class WorkingWidget {
	#frames: string[] = [];
	#index = 0;
	#intervalMs = WORKING_INTERVAL_MS;
	#interval: ReturnType<typeof setInterval> | undefined;
	#tui: WidgetTuiLike | undefined;
	#started = false;
	#disposed = false;

	setFrames(frames: string[], intervalMs: number): void {
		this.#frames = frames;
		this.#intervalMs = intervalMs;
		this.#index = 0;
	}

	attach(tui: WidgetTuiLike): void {
		this.#tui = tui;
	}

	/** Ask the host for a render — lets non-widget consumers (the thinking label
	 * ticker) reuse this widget's TUI handle instead of relying on natural
	 * streaming renders. */
	requestRender(): void {
		this.#tui?.requestRender();
	}

	/** @deprecated Token stats are owned by Pi and are no longer rendered here. */
	setStats(_text: string | undefined): void {}

	start(): void {
		if (this.#disposed || this.#started) return;
		this.#started = true;
		this.#index = 0;
		// A single frame has nothing to cycle — skip the 30fps render churn.
		if (this.#frames.length <= 1) return;
		this.#interval = setInterval(() => {
			this.#index = (this.#index + 1) % Math.max(1, this.#frames.length);
			this.#tui?.requestRender();
		}, this.#intervalMs);
	}

	stop(): void {
		this.#started = false;
		if (this.#interval) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}
	}

	/** Flush-left single line; invisible (no lines) while stopped. */
	render(width: number): string[] {
		if (!this.#started || this.#frames.length === 0) return [];
		const frame = this.#frames[this.#index % this.#frames.length] ?? "";
		return [truncateToWidth(frame, Math.max(1, width))];
	}

	invalidate(): void {
		// Stateless per render — nothing to invalidate.
	}

	dispose(): void {
		this.stop();
		this.#disposed = true;
	}
}
