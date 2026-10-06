// Run from the repo root: node tests/test-custom-footer.mjs
// For other install layouts: PI_NODE_MODULES=/path/to/node_modules node tests/test-custom-footer.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(
	install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules",
);
const pkg = (name, file) => join(modules, "@earendil-works", name, file);
const load = (file) => import(pathToFileURL(file).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": pkg("pi-coding-agent", "dist/index.js"),
	"@earendil-works/pi-tui": pkg("pi-tui", "dist/index.js"),
} });
const { default: extension } = await jiti.import(resolve("extensions/custom-footer.ts"));
const { visibleWidth } = await load(pkg("pi-tui", "dist/index.js"));
const { getThemeByName } = await load(pkg("pi-coding-agent", "dist/modes/interactive/theme/theme.js"));
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

for (const themeName of ["dark", "light"]) {
	const theme = getThemeByName(themeName);
	const events = new Map();
	const commands = new Map();
	let thinking = "low";
	const pi = {
		on(name, handler) {
			if (!events.has(name)) events.set(name, new Set());
			events.get(name).add(handler);
			return () => events.get(name).delete(handler);
		},
		registerCommand: (name, command) => commands.set(name, command),
		getThinkingLevel: () => thinking,
	};
	extension(pi);
	const emit = async (name, ctx) => {
		for (const handler of [...(events.get(name) ?? [])]) await handler({}, ctx);
	};
	let header, percent = 0, branch = "main", model = { name: "Opus 5.5", id: "opus" };
	let renders = 0, footerCalls = 0;
	const branchListeners = new Set();
	const ctx = {
		mode: "tui",
		get model() { return model; },
		getContextUsage: () => percent === undefined ? undefined : { percent },
		ui: {
			setFooter(factory) {
				footerCalls++;
				header?.dispose();
				header = factory?.({ requestRender: () => renders++ }, theme, {
					getGitBranch: () => branch,
					onBranchChange(handler) {
						branchListeners.add(handler);
						return () => branchListeners.delete(handler);
					},
				});
			},
			notify() {},
		},
	};
	await emit("session_start", ctx);
	const text = () => plain(header.render(120)[0]);
	assert.equal(text(), " ✦ Opus 5.5 · low · ──────── 0% · ⌥ main");
	assert(header.render(120)[0].includes(theme.fg("success", "──────── 0%")));
	for (let cells = 0; cells <= 8; cells++) {
		percent = cells * 12.5;
		assert(text().includes("━".repeat(cells) + "─".repeat(8 - cells)));
	}
	for (const [value, cells, display, color] of [
		[0, 0, "0", "success"], [50, 4, "50", "success"],
		[69.9, 6, "70", "success"], [70, 6, "70", "warning"],
		[90, 7, "90", "error"], [100, 8, "100", "error"],
		[-10, 0, "0", "success"], [120, 8, "100", "error"],
		[undefined, 0, "?", "dim"], [null, 0, "?", "dim"],
		[NaN, 0, "?", "dim"], [Infinity, 0, "?", "dim"],
	]) {
		percent = value;
		const context = `${"━".repeat(cells)}${"─".repeat(8 - cells)} ${display}%`;
		assert(header.render(120)[0].includes(theme.fg(color, context)));
		for (const width of [0, 1, 10, 20, 40, 80, 120]) {
			const lines = header.render(width);
			assert.equal(lines.length, 1);
			assert(visibleWidth(lines[0]) <= width, `${themeName}: width ${width}`);
		}
	}
	thinking = "high";
	await emit("thinking_level_select", ctx);
	assert.equal(renders, 1);
	assert(text().includes(" · high · "));
	model = { name: "", id: "another-model" };
	await emit("model_select", ctx);
	assert.equal(renders, 2);
	assert(text().includes("✦ another-model"));
	model = undefined;
	assert(text().includes("✦ no model"));
	branch = null;
	assert(!text().includes("⌥"));
	branch = "feature/test";
	for (const handler of branchListeners) handler();
	assert.equal(renders, 3);
	assert(text().endsWith("⌥ feature/test"));
	model = { name: "模型🙂 e\u0301\nmodel", id: "id" };
	branch = "分支🙂";
	assert(!text().includes("\n"));
	for (const width of [0, 1, 10, 20, 40, 80, 120]) assert(visibleWidth(header.render(width)[0]) <= width);

	const old = header;
	await commands.get("builtin-footer").handler("", ctx);
	assert.equal(header, undefined);
	old.dispose(); // cleanup is idempotent
	assert.equal(branchListeners.size, 0);
	assert.equal(events.get("model_select").size, 0);
	assert.equal(events.get("thinking_level_select").size, 0);
	await commands.get("custom-footer").handler("", ctx);
	await commands.get("custom-footer").handler("", ctx);
	assert.equal(branchListeners.size, 1);
	assert.equal(events.get("model_select").size, 1);
	assert.equal(events.get("thinking_level_select").size, 1);
	for (const mode of ["print", "json", "rpc"]) {
		const count = footerCalls;
		const nonTui = { ...ctx, mode };
		await emit("session_start", nonTui);
		await commands.get("custom-footer").handler("", nonTui);
		await commands.get("builtin-footer").handler("", nonTui);
		assert.equal(footerCalls, count);
	}
	header.dispose();
	console.log(`PASS ${themeName}: layout, live data, context/bar/colors, widths, Unicode, commands, subscriptions, non-TUI guards`);
}
