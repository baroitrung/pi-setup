// Account pool for Google Antigravity.
//
// pi-antigravity already rotates accounts, but only *inside* one request: after a
// hard quota wall it walks to the next login and forgets everything afterwards,
// so the next request starts on the exhausted account again. This extension adds
// the part that was missing:
//
//   • cooldown memory, per account and per model (a wall on gemini-3.8-flash does
//     not disable the account for claude-sonnet),
//   • sticky selection — implicit prompt caching is scoped to (account, project),
//     so the account only moves when it is actually walled,
//   • visibility: /pool shows who is blocked, until when, and who is active.
//
// It steers by rewriting pi's own credential entry (auth.json) for the provider.
// pi re-reads that file whenever its revision changes, so the switch applies to
// the next request with no restart. See docs/plans/active/omp-gap-extraction.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyQuotaWall } from "./lib/quota.ts";
import {
	applyBlock,
	blockUntil,
	DEFAULT_BLOCK_MS,
	describeRemaining,
	heal,
	pickAccount,
	type PoolAccount,
	type PoolState,
} from "./lib/rank.ts";
import {
	activeAccountId,
	displayName,
	listAccounts,
	loadAccounts,
	loadState,
	maskAccount,
	PROVIDER_ID,
	saveState,
	switchActive,
} from "./lib/store.ts";

function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	if (type === "info") console.log(text);
	else console.error(text);
}

interface LastError {
	text: string;
}

/** Last provider error in the transcript, if the run ended on one. */
function lastRunError(messages: readonly unknown[]): LastError | undefined {
	for (let i = messages.length - 1; i >= 0 && i >= messages.length - 6; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "assistant") continue;
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		if (typeof errorMessage === "string" && errorMessage.trim()) return { text: errorMessage };
	}
	return undefined;
}

/**
 * Heal expired blocks and, when the active account is walled for the current
 * model, move to a healthy one. Returns the resulting state (unwritten).
 */
function reconcile(modelId?: string): { state: PoolState; accounts: PoolAccount[]; current?: string } {
	const { state } = heal(loadState());
	const accounts = listAccounts(loadAccounts());
	const current = state.activeAccountId ?? activeAccountId();
	return { state: current ? { ...state, activeAccountId: current } : state, accounts, current };
}

function renderPool(state: PoolState, accounts: PoolAccount[], current?: string, modelId?: string): string {
	if (accounts.length === 0) return "No Antigravity accounts linked. Run /login antigravity.";
	const now = Date.now();
	const indexWidth = String(accounts.length).length;

	// Logins can share a masked prefix (`day***@gmail.com`), so where labels collide
	// show the full address instead of an ambiguous mask.
	const masked = accounts.map((account) => maskAccount(account));
	const seen = new Map<string, number>();
	for (const label of masked) seen.set(label, (seen.get(label) ?? 0) + 1);
	const labels = accounts.map((account, index) =>
		(seen.get(masked[index]) ?? 0) > 1 ? account.email || account.accountId : masked[index],
	);
	const labelWidth = Math.min(34, Math.max(...labels.map((label) => label.length)));

	const rows = accounts.map((account, index) => {
		const active = account.accountId === current;
		const block = blockUntil(state, account.accountId, modelId, now);
		const status = block ? `blocked ${describeRemaining(block.until, now)}` : "ready";
		const scope = block && state.blocks[account.accountId]?.["*"] ? "" : block ? " (model)" : "";
		const last = account.lastUsedAt ? `${describeRemaining(now - account.lastUsedAt, now)} ago` : "never";
		return [
			`${active ? "▸" : " "} ${String(index + 1).padStart(indexWidth)}.`,
			labels[index].padEnd(labelWidth),
			(status + scope).padEnd(20),
			`last ${last}`,
		].join(" ");
	});
	const blocked = accounts.filter((account) => blockUntil(state, account.accountId, modelId, now)).length;
	return [
		`Antigravity account pool · ${accounts.length} accounts · ${blocked} blocked${modelId ? ` for ${modelId}` : ""}`,
		...rows,
		"",
		"/pool next  switch now    /pool heal  drop expired blocks    /pool reset  clear all blocks",
	].join("\n");
}

/** Switches to the best healthy account, if there is one. */
function rotate(ctx: ExtensionContext, state: PoolState, accounts: PoolAccount[], modelId?: string, why?: string) {
	const active = state.activeAccountId ?? activeAccountId();
	const pick = pickAccount(accounts, state, Date.now(), modelId, active);
	if (!pick.account) {
		notify(ctx, `Antigravity: every account is out of quota${modelId ? ` for ${modelId}` : ""}.`, "warning");
		return undefined;
	}
	if (pick.account.accountId === active) {
		if (why) notify(ctx, `Antigravity: staying on ${maskAccount(pick.account)} — ${why}`, "info");
		return pick.account;
	}
	try {
		const switched = switchActive(pick.account.accountId);
		notify(
			ctx,
			`Antigravity: ${why ? `${why} → ` : ""}switched to ${maskAccount(switched)}${
				modelId ? ` (${modelId})` : ""
			}`,
			"warning",
		);
		return switched;
	} catch (error) {
		notify(ctx, `Antigravity: could not switch account — ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

export default function accountPool(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const before = loadState();
		const { state, healed } = heal(before);
		if (healed.length > 0) saveState(state);
		if (healed.length > 0 && ctx.mode === "tui") {
			notify(ctx, `Antigravity: ${healed.length} account block(s) expired.`, "info");
		}
		// A session can start on an account that walled in a previous session.
		if (healed.length > 0 || !state.activeAccountId) return;
		const accounts = listAccounts(loadAccounts());
		const modelId = ctx.model?.id;
		const current = state.activeAccountId ?? activeAccountId();
		if (current && !blockUntil(state, current, modelId, Date.now())) return;
		rotate(ctx, state, accounts, modelId, "active account is blocked");
	});

	pi.on("agent_end", (event, ctx) => {
		const failure = lastRunError(event.messages);
		if (!failure) return;
		const verdict = classifyQuotaWall(failure.text);
		if (!verdict.wall) return;

		const accounts = listAccounts(loadAccounts());
		if (accounts.length < 2) {
			notify(ctx, "Antigravity: quota wall, but only one account is linked.", "warning");
			return;
		}

		const current = activeAccountId() ?? loadState().activeAccountId;
		const target = accounts.find((account) => account.accountId === current);
		if (!target) return;

		const until = verdict.resetAt ?? Date.now() + DEFAULT_BLOCK_MS;
		const modelId = verdict.modelId ?? ctx.model?.id;
		const next = applyBlock(heal(loadState()).state, target.accountId, until, verdict.reason, modelId);
		saveState({ ...next, activeAccountId: current });

		const scope = modelId ? `for ${modelId} ` : "";
		notify(
			ctx,
			`Antigravity: ${maskAccount(target)} is out of quota ${scope}until ${new Date(until).toLocaleTimeString()} (${describeRemaining(until)}).`,
			"warning",
		);
		rotate(ctx, next, accounts, modelId, "quota wall");
	});

	pi.registerCommand("pool", {
		description: "Show or steer the Antigravity account pool",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			const modelId = ctx.model?.id;
			const { state, accounts, current } = reconcile(modelId);

			if (action === "" || action === "status") {
				notify(ctx, renderPool(state, accounts, current, modelId));
				return;
			}
			if (action === "next") {
				const pick = pickAccount(accounts, state, Date.now(), modelId, current);
				if (!pick.account) {
					notify(ctx, `Antigravity: every account is out of quota${modelId ? ` for ${modelId}` : ""}.`, "warning");
					return;
				}
				const switched = switchActive(pick.account.accountId);
				saveState({ ...state, activeAccountId: switched.accountId });
				notify(ctx, `Antigravity: switched to ${maskAccount(switched)}.`);
				return;
			}
			if (action === "heal") {
				const healed = heal(loadState());
				saveState(healed.state);
				notify(
					ctx,
					healed.healed.length === 0
						? "Antigravity: nothing to heal."
						: `Antigravity: cleared ${healed.healed.length} expired block(s).`,
				);
				return;
			}
			if (action === "reset") {
				saveState({ ...loadState(), blocks: {} });
				notify(ctx, "Antigravity: all account blocks cleared.");
				return;
			}
			notify(ctx, "Usage: /pool [status|next|heal|reset]", "warning");
		},
	});

	// Keep the provider id in one place for anything that imports this module.
	void PROVIDER_ID;
}
