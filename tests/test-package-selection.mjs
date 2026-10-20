// Run: node tests/test-package-selection.mjs
// Pure template checks: no package installation, credentials, or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(
	new URL("../config/settings.json", import.meta.url), "utf8",
));
const models = JSON.parse(readFileSync(
	new URL("../config/models.json", import.meta.url), "utf8",
));
const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry.source);
const packageIds = sources.map((source) => source.startsWith("npm:")
	? source.replace(/@[^@/]+$/, "") : source);
assert.equal(new Set(packageIds).size, packageIds.length, "package identities must not be duplicated");
for (const source of [
	"npm:pi-diff-review@0.1.27",
	"npm:pi-lsp-extension@1.4.0",
	"npm:pi-subagents@0.77.0",
]) {
	assert(sources.includes(source), `${source} must remain pinned`);
}
assert(sources.includes("npm:@narumitw/pi-goal"), "the standalone goal package must be enabled");
for (const alternate of ["npm:@tintinweb/pi-subagents", "npm:@gotgenes/pi-subagents"]) {
	assert(!packageIds.includes(alternate), "only one subagent implementation may be enabled");
}
for (const inactive of [
	"npm:pi-advisor-flow",
	"npm:pi-smart-fetch",
	"npm:pi-devin-local",
	"npm:@gotgenes/pi-permission-system",
	"npm:@plannotator/pi-extension",
]) {
	assert(!packageIds.includes(inactive), `${inactive} is not selected in the synced setup`);
}
assert(!sources.some((source) => source.includes("mitsuhiko/agent-stuff") || source.startsWith("npm:mitsupi")),
	"the old mitsupi bundle must not overlap with the standalone goal/subagent packages");
assert.equal(settings.theme, "system");
assert.equal(settings.lastChangelogVersion, "1.3.0");
assert(sources.includes("npm:pi-browser-use"), "browser extension must remain enabled");
assert.equal(settings.defaultProvider, "opencode-go");
assert.equal(settings.defaultModel, "deepseek-v4.1-flash");
assert.equal(settings.defaultThinkingLevel, "high");
assert.deepEqual(settings.extensions, ["-builtin:mcp"], "the MCP adapter replaces builtin MCP");
assert(!sources.some((source) => source === "git:github.com/ttttmr/pi-devin-oauth"),
	"the inactive Devin provider must not be reintroduced");
assert(!Object.hasOwn(settings["pi-browser-use"] ?? {}, "executablePath"),
	"shared browser config must use automatic discovery, not a machine-specific executablePath");
// models.json carries compat overrides only; credentials stay in auth.json.
const providers = Object.entries(models.providers ?? {});
assert(providers.length > 0, "models.json must configure at least one provider");
for (const [id, provider] of providers) {
	assert(provider.apiKey === undefined, `${id}: credentials must not be committed`);
	assert(provider.baseUrl === undefined, `${id}: the provider endpoint comes from Pi, not the repo`);
	const overrides = Object.entries(provider.modelOverrides ?? {});
	assert(overrides.length > 0, `${id}: expected model-scoped compat overrides`);
	for (const [model, override] of overrides) {
		assert.deepEqual(Object.keys(override), ["compat"], `${id}/${model}: only compat may be overridden here`);
		assert(override.compat.sendSessionAffinityHeaders === true, `${id}/${model}: session affinity stays enabled`);
	}
}
assert(models.providers["opencode-go"]?.modelOverrides?.["deepseek-v4.1-flash"],
	"the default model keeps its session-affinity override");
console.log("PASS: synced packages, standalone goal/subagents, opencode-go defaults, models.json compat, "
	+ "browser autodetection, removed packages absent");
