// Run: node tests/test-package-selection.mjs
// Pure template checks: no package installation, credentials, or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(
	new URL("../config/settings.json", import.meta.url), "utf8",
));
const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry.source);
assert.equal(new Set(sources).size, sources.length, "package sources must not be duplicated");
assert(sources.includes("npm:pi-diff-review@0.1.27"));
assert(sources.includes("npm:pi-lsp-extension@1.4.0"));
for (const legacy of ["npm:pi-subagents", "npm:@tintinweb/pi-subagents"]) {
	assert(!sources.includes(legacy), "legacy subagent package would collide with mitsupi's tool");
}
const matches = settings.packages.filter((entry) => typeof entry === "object"
	&& entry.source.startsWith("git:github.com/mitsuhiko/agent-stuff@"));
assert.equal(matches.length, 1);
const selected = matches[0];
assert.match(selected.source, /^git:github\.com\/mitsuhiko\/agent-stuff@[0-9a-f]{40}$/);
assert.deepEqual(selected.extensions, [
	"extensions/btw.ts", "extensions/session-breakdown.ts", "extensions/goal.ts", "extensions/subagent.ts",
]);
assert.deepEqual(selected.skills, ["skills/librarian", "skills/summarize"]);
assert.deepEqual(selected.themes, ["themes/dayowl.json", "themes/modern-dark.json", "themes/nightowl.json"]);
assert.deepEqual(selected.prompts, []);
assert(!sources.some((source) => source.startsWith("npm:mitsupi")), "npm package must not enable the whole bundle");
assert.equal(settings.theme, "system", "adding themes must not change the selected theme");
assert(sources.includes("npm:pi-devin-local"), "Devin Local provider must be installed");
assert.equal(settings.defaultProvider, "devin", "default provider must use the Devin plugin");
assert.equal(settings.defaultModel, "deepseek-v4.1-flash", "default model must use the Devin CLI family slug");
assert(!sources.some((source) => source === "git:github.com/ttttmr/pi-devin-oauth"),
	"pi-devin-oauth registers the same devin provider and must not be combined");
console.log("PASS: pinned diff/LSP, selected mitsupi resources, one Devin provider");
