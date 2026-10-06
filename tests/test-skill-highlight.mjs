// Run from the repository root:
//   PI_NODE_MODULES=<dir with @earendil-works/* and jiti> node tests/test-skill-highlight.mjs
//
// Exercises the real CustomEditor + real Pi theme; no model calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases",
	readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const agent = join(modules, "@earendil-works/pi-coding-agent");
const load = (path) => import(pathToFileURL(path).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(agent, "dist/index.js"),
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
} });

const { CURSOR_MARKER, TuiMainScreen, TuiAltScreen, stripTerminalSequences, visibleWidth } =
	await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { CustomEditor } = await load(join(agent, "dist/index.js"));
const { getEditorTheme, initTheme, loadThemeFromPath, setTheme, setTerminalColors, setThemeInstance, theme: activeTheme } =
	await load(join(agent, "dist/modes/interactive/theme/theme.js"));
const { KeybindingsManager } = await load(join(agent, "dist/core/keybindings.js"));

// `BG` is a *prefix* used to count painted ranges; `CHIP_OPEN` is the full
// opening sequence the extension writes, derived from the live theme.
const BG = "\x1b[48;2;";
const CHIP_OPEN = () => activeTheme.getBgAnsi("customMessageBg") + activeTheme.getFgAnsi("syntaxVariable") + "\x1b[1m";
const GLYPH = "💡";
const BOLD = "\x1b[1m";
setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });
initTheme("system");

// ---------------------------------------------------------------------------
// Harness: capture the factory the extension registers, then drive it.
// ---------------------------------------------------------------------------
const handlers = new Map();
let factory;
const { default: extension } = await jiti.import(
	process.env.SKILL_HIGHLIGHT_SOURCE || resolve("extensions/skill-highlight-editor.ts"));
extension({ on: (name, fn) => handlers.set(name, fn) });
assert(handlers.has("session_start"), "registers session_start");
assert(handlers.has("session_shutdown"), "registers session_shutdown");

const fakeUi = { get theme() { return activeTheme; }, setEditorComponent(fn) { factory = fn; } };
handlers.get("session_start")({}, { mode: "tui", cwd: process.cwd(), ui: fakeUi });
assert(typeof factory === "function", "installs an editor component in tui mode");

let nonTuiInstalls = 0;
handlers.get("session_start")({}, {
	mode: "rpc",
	cwd: process.cwd(),
	ui: { get theme() { return activeTheme; }, setEditorComponent() { nonTuiInstalls++; } },
});
assert.equal(nonTuiInstalls, 0, "does not replace the editor outside tui mode");

const cursorWrites = [];
let hardwareVisible = false;
const fakeTui = {
	terminal: { rows: 40, write(data) { cursorWrites.push(data); } },
	getShowHardwareCursor() { return hardwareVisible; },
	setShowHardwareCursor(value) { hardwareVisible = value; },
	requestRender() {},
};
const keybindings = KeybindingsManager.create();
const build = (text) => {
	const editor = factory(fakeTui, getEditorTheme(), keybindings);
	editor.onSubmit = () => {};
	editor.focused = true;
	editor.setText(text);
	return editor;
};
const stock = (text) => {
	const editor = new CustomEditor(fakeTui, getEditorTheme(), keybindings, { embedWorkingStatus: true });
	editor.onSubmit = () => {};
	editor.setText(text);
	return editor;
};
const render = (text, width = 100) => build(text).render(width);
const plain = (lines) => lines.map(stripTerminalSequences);
const plainBody = (lines) => plain(lines).slice(1, -1).join("\n");
const chipRow = (lines) => lines.find((line) => line.includes(GLYPH)) ?? "";

// ---------------------------------------------------------------------------
// Ordinary text is left exactly alone.
// ---------------------------------------------------------------------------
{
	const lines = render("hello world");
	assert(lines.length >= 3, "renders a bordered box");
	assert.equal(visibleWidth(lines[0]), 100, "top border spans the width");
	assert(plainBody(lines).includes("hello world"), "plain text is unchanged");
	assert(!lines.join("").includes(BG), "no highlight on ordinary text");
}

// ---------------------------------------------------------------------------
// A known invocation becomes a chip, and the chip is exactly as wide as the
// token it replaces — that is what keeps the layout untouched.
// ---------------------------------------------------------------------------
{
	const editor = build("/skill:git");
	const lines = editor.render(100);
	const row = chipRow(lines);
	assert(row.includes(GLYPH), "the invocation renders as a chip");
	assert(plain([row])[0].includes(`${GLYPH} git`), "the chip shows the glyph and the bare skill name");
	assert(!plain([row])[0].includes("/skill:"), "the canonical token is no longer shown");
	assert(row.includes(BG), "the chip is painted");
	assert(row.includes(BOLD), "the chip is bolded");
	assert.equal(editor.getText(), "/skill:git", "the submitted text is untouched");

	// `/skill:git` is 10 columns; `💡 git` is 6. The pad must be exactly 4, and
	// the pad must NOT be painted — the fill ends where the glyphs do.
	// Style opens as background, then foreground, then bold.
	assert(row.includes(`${CHIP_OPEN()}${GLYPH} git\x1b[0m    `),
		"the chip is padded, unpainted, back to the token width");
	assert.equal(visibleWidth(row), visibleWidth(stock("/skill:git").render(100)[1]),
		"the row is exactly as wide as the stock editor's");
}

// ---------------------------------------------------------------------------
// Width preservation holds for every name length, at several terminal widths.
// This is the property the whole approach rests on.
// ---------------------------------------------------------------------------
{
	for (const name of ["git", "read", "think", "brainstorm", "typesafe-ai", "accessibility-review"]) {
		for (const width of [20, 40, 80, 200]) {
			const text = `/skill:${name}`;
			assert.deepEqual(render(text, width).map(visibleWidth), stock(text).render(width).map(visibleWidth),
				`${name} @ ${width}: row widths match the stock editor`);
		}
	}
}

// ---------------------------------------------------------------------------
// A chip mid-line leaves the rest of the line in place.
// ---------------------------------------------------------------------------
{
	const lines = render("/skill:git hello world");
	assert(plainBody(lines).includes(`${GLYPH} git     hello world`),
		"the token is replaced and the following text keeps its column");
}

// ---------------------------------------------------------------------------
// An unknown name must never be painted or collapsed — no false positives.
// ---------------------------------------------------------------------------
{
	const text = "/skill:definitely-not-a-real-skill-xyz";
	const lines = render(text);
	assert(!lines.join("").includes(BG), "unknown skill name is not highlighted");
	assert(!lines.join("").includes(GLYPH), "unknown skill name is not collapsed");
	assert(plainBody(lines).includes(text), "text intact");
}

// ---------------------------------------------------------------------------
// `$git` is a real alias but only four columns wide, so the six-column chip
// cannot fit: it stays a token and is highlighted in place instead.
// ---------------------------------------------------------------------------
{
	const lines = render("$git");
	assert(!lines.join("").includes(GLYPH), "a too-narrow alias is not collapsed");
	assert(lines.join("").includes(BG), "but it is still highlighted");
	assert(plainBody(lines).includes("$git"), "alias text intact");
}

// ---------------------------------------------------------------------------
// The cursor inside a token keeps it literal, so the name stays editable.
// ---------------------------------------------------------------------------
{
	const editor = build("/skill:git");
	for (let i = 0; i < 4; i++) editor.handleInput("\x1b[D");
	const lines = editor.render(100);
	const raw = lines.join("");
	assert(raw.includes(CURSOR_MARKER), "hardware cursor marker is present");
	assert(!raw.includes("\x1b[7m"), "the fake block cursor is removed");
	assert(!raw.includes(GLYPH), "the token is not collapsed while the cursor is inside it");
	assert(raw.includes(BG), "the token is highlighted instead");
	const row = lines.find((line) => line.includes(CURSOR_MARKER));
	assert(row.lastIndexOf("\x1b[0m") > row.lastIndexOf(BG), "the cursor row ends with the style closed");
}

// ---------------------------------------------------------------------------
// The cursor's own reset must not kill the background mid-token.
// ---------------------------------------------------------------------------
{
	const editor = build("/skill:git");
	for (let i = 0; i < 4; i++) editor.handleInput("\x1b[D");
	const row = editor.render(100).find((line) => line.includes(CURSOR_MARKER));
	assert(row.includes(CURSOR_MARKER), "the native cursor is positioned");
	assert(!row.includes("\x1b[7m"), "no fake block remains");
	// After the cursor's reset the background must be re-opened, so the tail of
	// the token is still painted.
	const afterCursor = row.slice(row.indexOf(CURSOR_MARKER));
	assert(afterCursor.includes(BG), "the background is re-opened after the cursor's reset");
}

// ---------------------------------------------------------------------------
// At the very end of the invocation the chip appears, and the hardware cursor
// marker stays at the original cell.
// ---------------------------------------------------------------------------
{
	const editor = build("/skill:git");
	const lines = editor.render(100);
	const row = chipRow(lines);
	assert(row.includes(GLYPH), "the chip appears once the cursor clears the token");
	assert(editor.state.cursorCol === 10, "the cursor is at the end of the token");
	assert(row.includes(CURSOR_MARKER), "the hardware cursor remains after the chip");
	assert(!row.includes("\x1b[7m"), "there is no second block cursor");
}

// ---------------------------------------------------------------------------
// Two chips on one line.
// ---------------------------------------------------------------------------
{
	const lines = render("/skill:git /skill:read");
	const raw = lines.join("");
	assert.equal(raw.split(GLYPH).length - 1, 2, "both invocations collapse");
	assert.equal(raw.split(BG).length - 1, 2, "both chips are painted");
	assert(plainBody(lines).includes(`${GLYPH} git     ${GLYPH} read`), "both chips render in place");
	assert.deepEqual(lines.map(visibleWidth), stock("/skill:git /skill:read").render(100).map(visibleWidth),
		"the row is as wide as the stock editor's");
}

// ---------------------------------------------------------------------------
// A chip and a token the cursor is still inside, on one line.
// ---------------------------------------------------------------------------
{
	const editor = build("/skill:git /skill:read");
	for (let i = 0; i < 3; i++) editor.handleInput("\x1b[D");
	const lines = editor.render(100);
	const raw = lines.join("");
	assert(raw.includes(`${GLYPH} git`), "the finished chip collapses");
	assert(plain(lines).join("\n").includes("/skill:read"), "the token under the cursor stays literal");
	assert.equal(raw.split(BG).length - 1, 3, "chip and cursor-split token are all painted");
}

// ---------------------------------------------------------------------------
// Geometry parity with the stock editor, row for row, at every width — including
// the very narrow ones where a two-column glyph cannot be laid out.
// ---------------------------------------------------------------------------
{
	const text = "/skill:git some much longer argument text here that will wrap";
	for (const width of [1, 2, 3, 5, 10, 20, 40, 60, 100]) {
		assert.deepEqual(render(text, width).map(visibleWidth), stock(text).render(width).map(visibleWidth),
			`width ${width}: row widths match the stock editor`);
	}
	// A chip introduces a two-column glyph; the stock editor's wrapper cannot
	// make progress on one of those in a one- or two-column terminal. Painting
	// after layout means the extension cannot crash where the editor does not.
	for (const width of [1, 2, 3]) {
		assert.doesNotThrow(() => render("/skill:git", width), `width ${width}: no crash`);
	}
	const wide = render(`/skill:git ${"x".repeat(500)}`);
	for (const line of wide) assert(visibleWidth(line) <= 100, "very long line stays within width");
}

// ---------------------------------------------------------------------------
// When the wrapper splits a token across rows, no row holds the whole token and
// no chip is drawn — there is no room for it.
// ---------------------------------------------------------------------------
{
	const lines = render("/skill:git", 10);
	assert(!lines.join("").includes(GLYPH), "a token split across rows is not chipped");
	assert.deepEqual(lines.map(visibleWidth), stock("/skill:git").render(10).map(visibleWidth),
		"and the geometry still matches the stock editor");
}

// ---------------------------------------------------------------------------
// Theme changes are picked up live, and dark/light both produce a background.
// ---------------------------------------------------------------------------
{
	const themeDir = join(agent, "dist/modes/interactive/theme");
	for (const name of ["dark", "light"]) {
		setThemeInstance(loadThemeFromPath(join(themeDir, `${name}.json`)));
		const lines = render("/skill:git");
		assert(lines.join("").includes(BG), `${name}: chip is painted`);
		assert(lines.join("").includes(GLYPH), `${name}: chip is drawn`);
		assert.equal(visibleWidth(lines[1]), 100, `${name}: width preserved`);
	}
	setTheme("system");
}

// ---------------------------------------------------------------------------
// Malformed / hostile input must render without throwing and without leaking.
// ---------------------------------------------------------------------------
{
	const cases = [
		"", "   ", "/skill:", "/skill:git /skill:", "$git", "$$git",
		"/skill:git\n/skill:read", "a".repeat(1000), "/skill:" + "g".repeat(300),
		"\u001b[31m/skill:git\u001b[0m", "/skill:git \u001b]0;evil\u0007",
		"/skill:git\u001b[7m", `${GLYPH} git`, "/skill:git /skill:git",
		"$think", "/skill:think$read", "💡", "\u001b[7m",
	];
	for (const text of cases) {
		let lines;
		assert.doesNotThrow(() => { lines = render(text); }, `renders without throwing for ${JSON.stringify(text.slice(0, 24))}`);
		assert(Array.isArray(lines), `renders array for ${JSON.stringify(text.slice(0, 24))}`);
		for (const line of lines) {
			const reset = Math.max(line.lastIndexOf("\x1b[49m"), line.lastIndexOf("\x1b[0m"));
			assert(reset > line.lastIndexOf(BG) || !line.includes(BG),
				`no unterminated background for ${JSON.stringify(text.slice(0, 24))}`);
		}
	}
}

// ---------------------------------------------------------------------------
// The editor's text is never mutated, whatever is on the line.
// ---------------------------------------------------------------------------
{
	for (const text of ["/skill:git", "/skill:git hello", "$think", "/skill:git /skill:read", "plain"]) {
		const editor = build(text);
		editor.render(100);
		assert.equal(editor.getText(), text, `text survives render: ${JSON.stringify(text)}`);
	}
}

// ---------------------------------------------------------------------------
// Native cursor: setup is once per TUI, no writes during render, and cursor
// columns agree with stock for start/end, wrapping, wide/combining graphemes.
// ---------------------------------------------------------------------------
{
	assert(hardwareVisible, "the native cursor is enabled without changing settings");
	assert.equal(cursorWrites.filter((data) => data === "\x1b[6 q").length, 1, "beam selected once");
	for (const text of ["", "hello", "日本語", "e\u0301 hello", "/skill:git", "/skill:git hello", "$think"]) {
		for (const width of [20, 40, 100]) {
			const editor = build(text);
			const baseline = stock(text);
			baseline.focused = true;
			for (let left = 0; left <= [...text].length; left++) {
				const actual = editor.render(width);
				const expected = baseline.render(width);
				const cursor = (lines) => {
					const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
					assert(row >= 0, "focused editor retains the marker");
					return [row, visibleWidth(lines[row].slice(0, lines[row].indexOf(CURSOR_MARKER)))];
				};
				assert.deepEqual(cursor(actual), cursor(expected), `${text} @ ${width}: cursor cell matches stock`);
				assert(!actual.join("").includes("\x1b[7m"), "only the native caret remains");
				assert.deepEqual(actual.map(visibleWidth), expected.map(visibleWidth), "row geometry matches");
				editor.handleInput("\x1b[D");
				baseline.handleInput("\x1b[D");
			}
		}
	}
	assert.equal(cursorWrites.length, 1, "renders do not write terminal controls");
	const editor = build("/skill:git");
	for (let i = 0; i < 10; i++) editor.handleInput("\x1b[D");
	assert(!editor.render(100).join("").includes(GLYPH), "cursor at token start keeps it literal");
	hardwareVisible = false;
	assert(editor.render(100).join("").includes("\x1b[7m"), "disabling hardware mode restores the block fallback");
	hardwareVisible = true;
}

// Shutdown restores the previous visibility/default shape and is idempotent.
// ---------------------------------------------------------------------------
{
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	assert.equal(hardwareVisible, false, "prior cursor visibility restored");
	assert.equal(cursorWrites.at(-1), "\x1b[0 q", "terminal default shape restored");
	const count = cursorWrites.length;
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	assert.equal(cursorWrites.length, count, "shutdown is idempotent");
	const lines = render("/skill:git");
	assert(Array.isArray(lines), "still renders after shutdown");
}

// Real TUI integration in regular/fullscreen mode. The TUI, not the extension,
// positions and shows the native cursor and hides it when focus is released.
for (const [label, Tui] of [["regular", TuiMainScreen], ["fullscreen", TuiAltScreen]]) {
	const events = [];
	const terminal = {
		rows: 30, columns: 80, kittyProtocolActive: false,
		start() {}, stop() {}, drainInput: async () => {},
		write(data) { events.push(data); },
		showCursor() { events.push("show"); }, hideCursor() { events.push("hide"); },
		moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new Tui(terminal, false);
	const editor = factory(tui, getEditorTheme(), keybindings);
	editor.setText("/skill:git hello");
	if (label === "fullscreen") tui.setLayoutRoot(editor);
	else tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow(true);
	assert(events.includes("\x1b[6 q"), `${label}: vertical beam requested`);
	const visibility = () => events.flatMap((event) => {
		if (event === "show" || event === "hide") return [event];
		return [...event.matchAll(/\x1b\[\?25([hl])/g)].map((match) => match[1] === "h" ? "show" : "hide");
	}).at(-1);
	assert.equal(visibility(), "show", `${label}: the real TUI shows the cursor`);
	assert(!events.join("").includes("\x1b[7m"), `${label}: no fake block written`);
	tui.setFocus(null);
	tui.renderNow(true);
	assert.equal(visibility(), "hide", `${label}: releasing focus hides hardware cursor`);
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	assert.equal(tui.getShowHardwareCursor(), false, `${label}: shutdown restores visibility`);
	tui.stop();
}

// Theme failure must not disable the caret. Unsupported terminal APIs must keep
// the stock block rather than silently remove the only visible cursor.
{
	const isolated = (theme) => {
		const hooks = new Map();
		let create;
		extension({ on: (name, fn) => hooks.set(name, fn) });
		hooks.get("session_start")({}, {
			mode: "tui", cwd: process.cwd(), ui: { theme, setEditorComponent(fn) { create = fn; } },
		});
		return { hooks, create };
	};
	const brokenTheme = isolated({});
	const editor = brokenTheme.create(fakeTui, getEditorTheme(), keybindings);
	editor.focused = true;
	editor.setText("hello");
	assert(!editor.render(40).join("").includes("\x1b[7m"), "theme failure still uses native caret");
	brokenTheme.hooks.get("session_shutdown")({});

	hardwareVisible = true;
	const alreadyVisible = isolated(activeTheme);
	alreadyVisible.create(fakeTui, getEditorTheme(), keybindings);
	alreadyVisible.hooks.get("session_shutdown")({});
	assert.equal(hardwareVisible, true, "an originally enabled hardware cursor stays enabled");
	hardwareVisible = false;

	for (const tui of [
		{ terminal: { rows: 40 }, requestRender() {} },
		{ terminal: { rows: 40, write() { throw new Error("closed"); } },
			getShowHardwareCursor() { return false; }, setShowHardwareCursor() {}, requestRender() {} },
	]) {
		const session = isolated(activeTheme);
		const editor = session.create(tui, getEditorTheme(), keybindings);
		editor.focused = true;
		editor.setText("hello");
		assert(editor.render(40).join("").includes("\x1b[7m"), "unsupported runtime keeps block fallback");
		assert.doesNotThrow(() => session.hooks.get("session_shutdown")({}), "cleanup is best effort");
	}
}

console.log("PASS skill-highlight-editor: chips, geometry, native beam cursor, lifecycle, "
	+ "regular/fullscreen focus, fallback, themes, hostile input");
