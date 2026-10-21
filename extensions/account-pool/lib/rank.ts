// Pure ranking and cooldown logic for the account pool. No fs, no clock, no
// provider knowledge — every function takes `now` so tests can drive it.

export const ANY_MODEL = "*";
export const DEFAULT_BLOCK_MS = 30 * 60 * 1_000;

export interface PoolAccount {
	accountId: string;
	email?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	projectId?: string;
	type?: string;
	lastUsedAt?: number;
	addedAt?: number;
}

export interface Block {
	until: number;
	reason?: string;
}

export interface PoolState {
	version: 1;
	activeAccountId?: string;
	/** accountId → blockScope → block. Scope is a model id or `*` for every model. */
	blocks: Record<string, Record<string, Block>>;
}

export function emptyState(): PoolState {
	return { version: 1, blocks: {} };
}

export function blockScope(modelId?: string): string {
	return modelId?.trim() || ANY_MODEL;
}

/** Active block for this account/model, honouring the wildcard scope. */
export function blockUntil(state: PoolState, accountId: string, modelId?: string, now = Date.now()): Block | undefined {
	const scopes = state.blocks[accountId];
	if (!scopes) return undefined;
	for (const scope of [blockScope(modelId), ANY_MODEL]) {
		const block = scopes[scope];
		if (block && block.until > now) return block;
	}
	return undefined;
}

export function applyBlock(
	state: PoolState,
	accountId: string,
	until: number,
	reason?: string,
	modelId?: string,
): PoolState {
	const scope = blockScope(modelId);
	const scopes = { ...(state.blocks[accountId] ?? {}) };
	scopes[scope] = { until, ...(reason ? { reason } : {}) };
	return { ...state, blocks: { ...state.blocks, [accountId]: scopes } };
}

/** Drops expired blocks so a healed account ranks as healthy again. */
export function heal(state: PoolState, now = Date.now()): { state: PoolState; healed: string[] } {
	const healed: string[] = [];
	const blocks: PoolState["blocks"] = {};
	for (const [accountId, scopes] of Object.entries(state.blocks)) {
		const live: Record<string, Block> = {};
		for (const [scope, block] of Object.entries(scopes)) {
			if (block.until > now) live[scope] = block;
			else healed.push(`${accountId}:${scope}`);
		}
		if (Object.keys(live).length > 0) blocks[accountId] = live;
	}
	return { state: { ...state, blocks }, healed };
}

/**
 * Healthy accounts first (least recently used first, to spread load), then the
 * blocked ones by soonest reset. The caller applies stickiness separately.
 */
export function rankAccounts(
	accounts: PoolAccount[],
	state: PoolState,
	now = Date.now(),
	modelId?: string,
): PoolAccount[] {
	return [...accounts].sort((a, b) => {
		const blockedA = blockUntil(state, a.accountId, modelId, now);
		const blockedB = blockUntil(state, b.accountId, modelId, now);
		if (Boolean(blockedA) !== Boolean(blockedB)) return blockedA ? 1 : -1;
		if (blockedA && blockedB && blockedA.until !== blockedB.until) return blockedA.until - blockedB.until;
		return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
	});
}

export type PickReason = "sticky" | "rotated" | "all-blocked" | "no-accounts";

export interface Pick {
	account?: PoolAccount;
	reason: PickReason;
}

/**
 * Chooses the account for the next request.
 *
 * Stickiness is deliberate: implicit prompt caching is scoped to (account,
 * projectId), so moving accounts throws the cached prefix away. Keep the current
 * account until it is blocked, and only then move once.
 */
export function pickAccount(
	accounts: PoolAccount[],
	state: PoolState,
	now = Date.now(),
	modelId?: string,
	activeAccountId?: string,
): Pick {
	if (accounts.length === 0) return { reason: "no-accounts" };
	const wanted = activeAccountId ?? state.activeAccountId;
	if (wanted) {
		const current = accounts.find((account) => account.accountId === wanted);
		if (current && !blockUntil(state, current.accountId, modelId, now)) {
			return { account: current, reason: "sticky" };
		}
	}
	const healthy = rankAccounts(accounts, state, now, modelId).find(
		(account) => !blockUntil(state, account.accountId, modelId, now),
	);
	return healthy ? { account: healthy, reason: "rotated" } : { reason: "all-blocked" };
}

export function describeRemaining(until: number, now = Date.now()): string {
	const ms = Math.max(0, until - now);
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
