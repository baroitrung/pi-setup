// Classifies the error text a failing provider surfaces as a quota wall.
//
// pi-antigravity already classifies its own HTTP responses (stream/stream.ts
// `friendlyAntigravityError`) and the classification is preserved in the thrown
// error message. We do not re-derive it from raw HTTP, because extension hooks
// never see the response body for a custom API (see the plan's spike findings):
//
//   hard wall  → "Quota reached. Please wait 4h 12m. Next: switch models or retry later."
//   transient  → "Rate limited by Antigravity (429 ResourceExhausted). Next: retrying ..."
//   dead model → "This model is unavailable right now (...). ... not necessarily an account quota wall."
//
// Only the first one means "this account is out of quota for this model". Getting
// that wrong burns a healthy account, so the match stays narrow on purpose.

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

export interface QuotaVerdict {
	wall: boolean;
	/** Epoch ms when the window resets, when the provider told us. */
	resetAt?: number;
	/** Model named in the provider's diagnostics suffix, when present. */
	modelId?: string;
	/** Short human reason, safe to store and display (no tokens, no URLs). */
	reason: string;
}

export function firstLine(text: string): string {
	return text.trim().split(/\r?\n/, 1)[0].slice(0, 240);
}

/** Parses "Resets in 4h 12m", "Please wait 4h 12m", "... in 90 seconds", or an ISO timestamp. */
export function parseResetAt(text: string, now = Date.now()): number | undefined {
	const hint =
		/resets? in ([^.\n,;]+)/i.exec(text)?.[1]?.trim() ??
		/please wait ([^.\n,;]+)/i.exec(text)?.[1]?.trim();
	if (!hint) return undefined;
	if (/^(for|the|until)\b/i.test(hint)) return undefined;

	const parts = hint.match(/(\d+(?:\.\d+)?)\s*([dhms])/gi);
	if (parts?.length) {
		let total = 0;
		for (const part of parts) {
			const parsed = /(\d+(?:\.\d+)?)\s*([dhms])/i.exec(part);
			if (!parsed) continue;
			total += Number(parsed[1]) * UNIT_MS[parsed[2].toLowerCase() as keyof typeof UNIT_MS];
		}
		return total > 0 ? now + Math.round(total) : undefined;
	}

	const seconds = /^(\d+)\s*(?:s|secs?|seconds?)?$/i.exec(hint);
	if (seconds) return now + Number(seconds[1]) * 1_000;

	const absolute = Date.parse(hint);
	return Number.isFinite(absolute) ? absolute : undefined;
}

/** Reads `runtimeModel=...` out of pi-antigravity's request diagnostics suffix. */
export function modelFromError(text: string): string | undefined {
	const match = /runtimeModel=([^,\s]+)/.exec(text);
	if (!match) return undefined;
	const value = match[1].trim();
	return value && value !== "unknown" ? value : undefined;
}

export function classifyQuotaWall(text: string, now = Date.now()): QuotaVerdict {
	const quoted = /quota reached/i.test(text) || /individual quota/i.test(text);
	if (!quoted) return { wall: false, reason: "" };
	return {
		wall: true,
		resetAt: parseResetAt(text, now),
		modelId: modelFromError(text),
		reason: firstLine(text),
	};
}
