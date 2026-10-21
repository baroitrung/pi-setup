// Disk access for the account pool. Two files are shared with pi-antigravity and
// one is ours:
//
//   ~/.pi/agent/auth.json                   pi's credential store (we swap the active entry)
//   ~/.pi/agent/antigravity-accounts.json   pi-antigravity's pool (we set activeAccountId)
//   ~/.pi/agent/account-pool-state.json     our cooldown bookkeeping (never holds tokens)
//
// pi re-reads auth.json whenever its revision changes, so a write here takes
// effect on the next request without restarting the session.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emptyState, type PoolAccount, type PoolState } from "./rank.ts";

export const PROVIDER_ID = "antigravity";
export const ACCOUNTS_FILE = "antigravity-accounts.json";
export const AUTH_FILE = "auth.json";
export const STATE_FILE = "account-pool-state.json";

/** Directory holding auth.json / accounts / state. Tests point this at a temp dir. */
export function agentDir(): string {
	return process.env.PI_ACCOUNT_POOL_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function accountsPath(): string {
	return join(agentDir(), ACCOUNTS_FILE);
}

export function authPath(): string {
	return join(agentDir(), AUTH_FILE);
}

export function statePath(): string {
	return join(agentDir(), STATE_FILE);
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Write, then chmod, then rename: readers never observe a half-written file. */
function writeJsonPrivate(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

export interface AccountsFile {
	version: 1;
	activeAccountId?: string;
	accounts: Record<string, PoolAccount>;
}

export function loadAccounts(): AccountsFile {
	const raw = readJson(accountsPath());
	const accounts: Record<string, PoolAccount> = {};
	const source = raw?.accounts;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		for (const [accountId, value] of Object.entries(source as Record<string, unknown>)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			accounts[accountId] = { ...(value as PoolAccount), accountId };
		}
	}
	const active = raw?.activeAccountId;
	return {
		version: 1,
		...(typeof active === "string" && accounts[active] ? { activeAccountId: active } : {}),
		accounts,
	};
}

export function listAccounts(store = loadAccounts()): PoolAccount[] {
	return Object.values(store.accounts).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

export function loadState(): PoolState {
	const raw = readJson(statePath());
	const state = emptyState();
	if (!raw) return state;
	if (typeof raw.activeAccountId === "string") state.activeAccountId = raw.activeAccountId;
	const blocks = raw.blocks;
	if (blocks && typeof blocks === "object" && !Array.isArray(blocks)) {
		for (const [accountId, scopes] of Object.entries(blocks as Record<string, unknown>)) {
			if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue;
			const kept: Record<string, { until: number; reason?: string }> = {};
			for (const [scope, block] of Object.entries(scopes as Record<string, unknown>)) {
				if (!block || typeof block !== "object" || Array.isArray(block)) continue;
				const until = (block as { until?: unknown }).until;
				if (typeof until !== "number" || !Number.isFinite(until)) continue;
				const reason = (block as { reason?: unknown }).reason;
				kept[scope] = { until, ...(typeof reason === "string" ? { reason } : {}) };
			}
			if (Object.keys(kept).length > 0) state.blocks[accountId] = kept;
		}
	}
	return state;
}

export function saveState(state: PoolState): void {
	writeJsonPrivate(statePath(), state);
}

function authEntryFor(account: PoolAccount): Record<string, unknown> {
	const entry: Record<string, unknown> = { type: "oauth" };
	for (const key of ["access", "refresh", "expires", "projectId", "email"] as const) {
		const value = account[key];
		if (value !== undefined && value !== "") entry[key] = value;
	}
	return entry;
}

/**
 * Makes `accountId` the active credential. Writes pi's auth.json entry (so the
 * next request resolves that account) and mirrors the choice into
 * pi-antigravity's store so its own failover and `/antigravity.accounts` agree.
 */
export function switchActive(accountId: string): PoolAccount {
	const store = loadAccounts();
	const account = store.accounts[accountId];
	if (!account) throw new Error(`Unknown account: ${accountId}`);

	const auth = readJson(authPath()) ?? {};
	auth[PROVIDER_ID] = authEntryFor(account);
	writeJsonPrivate(authPath(), auth);

	writeJsonPrivate(accountsPath(), {
		...store,
		activeAccountId: accountId,
		accounts: { ...store.accounts, [accountId]: { ...account, lastUsedAt: Date.now() } },
	});

	const state = loadState();
	saveState({ ...state, activeAccountId: accountId });
	return account;
}

/** Active account id, preferring the credential actually in auth.json. */
export function activeAccountId(): string | undefined {
	const auth = readJson(authPath());
	const entry = auth?.[PROVIDER_ID] as { projectId?: unknown; email?: unknown } | undefined;
	const store = loadAccounts();
	if (entry) {
		const matched = Object.values(store.accounts).find(
			(account) =>
				(typeof entry.projectId === "string" && account.projectId === entry.projectId) ||
				(typeof entry.email === "string" && account.email === entry.email),
		);
		if (matched) return matched.accountId;
	}
	return store.activeAccountId;
}

export function displayName(account: PoolAccount): string {
	return account.email || account.accountId;
}

export function maskAccount(account: PoolAccount): string {
	const email = account.email;
	if (!email) return account.accountId.slice(0, 6);
	const [user, domain] = email.split("@");
	if (!domain) return account.accountId.slice(0, 6);
	const head = user.slice(0, 3);
	return `${head}${user.length > 3 ? "***" : ""}@${domain}`;
}
