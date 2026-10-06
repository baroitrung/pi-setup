import {
	CustomEditor,
	getAgentDir,
	loadSkills,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Inline skill chips in the prompt editor.
 *
 * A known invocation is drawn as a chip over the token it stands for:
 *
 *     /skill:think   ->   💡 think
 *
 * The focused editor uses the terminal's native steady vertical beam instead
 * of Pi's simulated inverse-video block. Cursor geometry remains stock; the
 * TUI owns positioning/focus and cleanup restores the terminal default shape.
 *
 * The chip is painted onto the *rendered* line, after the editor has laid it
 * out. Nothing is swapped into the editor's state and no part of its layout is
 * reimplemented, so wrapping, cursor placement and click-to-position are the
 * stock ones by construction — at every terminal width, including the very
 * narrow ones where a two-column glyph cannot be laid out at all. When the
 * wrapper splits a token across rows, no row holds the whole token and no chip
 * is drawn: there is no room for it.
 *
 * `/skill:` is seven characters and the chip's `💡 ` is three columns wide, so a
 * chip is always four columns short of the token it replaces. Padding it back to
 * the token's width is what keeps the substitution invisible to the layout: the
 * chip occupies exactly the columns the token did, so the text after it, the
 * cursor and the line's trailing padding are all untouched. Only the chip itself
 * is painted, so the fill ends where the visible glyphs do.
 *
 * The cursor is left inside an invocation while it is being edited. Collapsing
 * there would leave the arrow keys stepping through a chip they cannot address,
 * so the chip appears once the cursor clears the token and the plain highlighted
 * token is shown in the meantime.
 */

/** CSI SGR sequence, or the zero-width hardware-cursor marker. */
const ESCAPE = /^(?:\x1b\[[0-9;]*m|\x1b_pi:c\x07)/;

/** The editor's fake cursor: the one place it sets inverse video. */
const CURSOR = "\x1b[7m";

/** DECSCUSR: steady vertical beam; reset to the terminal default on release. */
const BEAM_CURSOR = "\x1b[6 q";
const DEFAULT_CURSOR = "\x1b[0 q";

/** A skill invocation as typed, in either the canonical form or the `$` alias. */
const SKILL_TOKEN = /(?:\/skill:([a-zA-Z0-9-]+)|\$([a-zA-Z0-9-]+))/g;

/** The chip's leading glyph. Two columns wide in every font Pi measures. */
const GLYPH = "💡";

/** True when an escape sequence clears the style and it must be re-applied. */
function dropsStyle(sequence: string): boolean {
	if (!sequence.startsWith("\x1b[")) return false;
	const body = sequence.slice(2, -1);
	if (body === "") return true;
	return body.split(";").some((code) => code === "0" || code === "22" || code === "49");
}

/** The plain characters of a rendered line, with the raw offset of each one. */
function plainIndex(line: string): { text: string; offsets: number[] } {
	let text = "";
	const offsets: number[] = [];
	let raw = 0;
	while (raw < line.length) {
		if (line[raw] === "\x1b") {
			const escape = ESCAPE.exec(line.slice(raw));
			if (escape) {
				raw += escape[0].length;
				continue;
			}
		}
		const width = (line.codePointAt(raw) ?? 0) > 0xffff ? 2 : 1;
		text += line.slice(raw, raw + width);
		for (let index = 0; index < width; index += 1) offsets.push(raw);
		raw += width;
	}
	// Sentinel, so a range ending at the end of the line still has a raw offset.
	offsets.push(line.length);
	return { text, offsets };
}

/** `raw` wrapped in `open`, re-opening the style after any escape that clears it. */
function styled(raw: string, open: string): string {
	let output = open;
	let index = 0;
	while (index < raw.length) {
		if (raw[index] === "\x1b") {
			const escape = ESCAPE.exec(raw.slice(index));
			if (escape) {
				output += escape[0];
				index += escape[0].length;
				if (dropsStyle(escape[0])) output += open;
				continue;
			}
		}
		output += raw[index];
		index += 1;
	}
	return `${output}\x1b[0m`;
}

/**
 * The chip standing in for `token`, split into the painted part and the padding
 * that keeps the token's width, or `undefined` when it cannot fit.
 */
function chipFor(invocation: string, name: string): { chip: string; pad: string } | undefined {
	const chip = `${GLYPH} ${name}`;
	const padding = invocation.length - visibleWidth(chip);
	if (padding < 0) return undefined;
	return { chip, pad: " ".repeat(padding) };
}

/**
 * Paint chips and highlight tokens on one rendered line.
 *
 * Ranges are located in the line's plain text and sliced back out of the raw
 * line, so escapes elsewhere on the line survive untouched. A range the cursor
 * sits inside is styled rather than collapsed, which is what keeps the name
 * editable with the arrow keys.
 */
function paintLine(line: string, known: Set<string>, open: string): string {
	const { text, offsets } = plainIndex(line);

	const markerRaw = line.indexOf(CURSOR_MARKER);
	const cursorRaw = markerRaw >= 0 ? markerRaw : line.indexOf(CURSOR);
	const cursorCol = cursorRaw < 0 ? -1 : plainIndex(line.slice(0, cursorRaw)).text.length;

	let output = "";
	let last = 0;
	for (const match of text.matchAll(SKILL_TOKEN)) {
		const name = (match[1] ?? match[2] ?? "").toLowerCase();
		if (!name || !known.has(name)) continue;

		const start = match.index;
		const end = start + match[0].length;
		const rawStart = offsets[start];
		// The raw end of the match's *last character*, not `offsets[end]`: that
		// offset is where the next character begins, so slicing to it would swallow
		// any escape sitting between the two — including the cursor's `\x1b[7m`.
		const lastChar = end - 1;
		const rawEnd = offsets[lastChar] + ((text.codePointAt(lastChar) ?? 0) > 0xffff ? 2 : 1);
		const raw = line.slice(rawStart, rawEnd);

		const held = cursorCol >= start && cursorCol < end;
		const chip = held ? undefined : chipFor(match[0], name);

		output += line.slice(last, rawStart);
		output += chip ? `${open}${chip.chip}\x1b[0m${chip.pad}` : styled(raw, open);
		last = rawEnd;
	}
	return output + line.slice(last);
}

export default function skillHighlightEditor(pi: ExtensionAPI) {
	let known = new Set<string>();
	let loadedAt = 0;
	let cursorTui: TUI | undefined;
	let releaseCursor: (() => void) | undefined;

	const enableBeam = (tui: TUI): void => {
		if (cursorTui === tui) {
			// /reload reapplies persisted showHardwareCursor *after* session_start.
			// Renew the active editor's cursor lease without replacing the original
			// visibility captured for cleanup or writing controls on every frame.
			try {
				if (!tui.getShowHardwareCursor()) {
					tui.terminal.write(BEAM_CURSOR);
					tui.setShowHardwareCursor(true);
				}
			} catch { /* A failed renewal keeps the stock cursor fallback. */ }
			return;
		}
		releaseCursor?.();
		let previous: boolean;
		try {
			previous = tui.getShowHardwareCursor();
		} catch {
			return; // Older/unsupported runtimes keep the stock block cursor.
		}
		const release = (): void => {
			cursorTui = undefined;
			releaseCursor = undefined;
			try { tui.setShowHardwareCursor(previous); } catch { /* Cosmetic only. */ }
			try { tui.terminal.write(DEFAULT_CURSOR); } catch { /* Terminal may have closed. */ }
		};
		try {
			tui.terminal.write(BEAM_CURSOR);
			tui.setShowHardwareCursor(true);
			cursorTui = tui;
			releaseCursor = release;
		} catch {
			release();
		}
	};

	const refresh = (cwd: string): void => {
		try {
			const result = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
			known = new Set(result.skills.map((skill) => skill.name.toLowerCase()));
			loadedAt = Date.now();
		} catch {
			// Keep the previous set. Highlighting is cosmetic and must never break input.
		}
	};

	class SkillHighlightEditor extends CustomEditor {
		private readonly style: () => string | undefined;
		private readonly cwd: string;

		constructor(
			tui: TUI,
			editorTheme: EditorTheme,
			keybindings: KeybindingsManager,
			style: () => string | undefined,
			cwd: string,
		) {
			// `embedWorkingStatus` is a constructor option Pi cannot copy onto a
			// replacement editor, so it has to be passed here to keep the working
			// indicator rendering in the editor's top border.
			super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
			this.style = style;
			this.cwd = cwd;
		}

		render(width: number): string[] {
			// Resolve skills against the session cwd, not the process cwd: a resumed
			// session can run in a different project than the agent was launched in.
			if (Date.now() - loadedAt > 5000) refresh(this.cwd);

			// Only renew while this editor is focused and still owns the lease:
			// never reactivate a released runtime or steal focus from an overlay.
			if (this.focused && cursorTui === this.tui) enableBeam(this.tui);
			const lines = super.render(width);

			let open: string | undefined;
			try { open = this.style(); } catch { /* Cursor still works without a theme. */ }
			let nativeCursor = false;
			try {
				nativeCursor = cursorTui === this.tui && this.tui.getShowHardwareCursor();
			} catch { /* Keep the block if the hardware cursor is unavailable. */ }

			return lines.map((line) => {
				let decorated = line;
				try {
					if (open) decorated = paintLine(line, known, open);
				} catch { /* Keep the stock render on a highlighting failure. */ }
				// Only remove the fake inverse cursor immediately following Pi's
				// focused-editor marker. Keep its grapheme/reset, width and marker;
				// the TUI positions/shows the real cursor and owns overlay focus.
				return nativeCursor
					? decorated.replace(`${CURSOR_MARKER}${CURSOR}`, CURSOR_MARKER)
					: decorated;
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		refresh(ctx.cwd);

		// `ctx.ui.theme` is the live theme proxy, so reading it at render time
		// follows `/theme` changes without re-registering the editor.
		const theme = ctx.ui.theme as Theme;
		const style = (): string | undefined => {
			try {
				// The chip is a filled block: the surface Pi already gives the
				// `[skill]` block in the transcript, with the glyph and name in the
				// teal it uses for variables, bolded.
				const background = theme.getBgAnsi("customMessageBg");
				const foreground = theme.getFgAnsi("syntaxVariable");
				const value = `${background}${foreground}\x1b[1m`;
				return value.length > 0 ? value : undefined;
			} catch {
				return undefined;
			}
		};

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			enableBeam(tui);
			return new SkillHighlightEditor(tui, editorTheme, keybindings, style, ctx.cwd);
		});
	});

	pi.on("session_shutdown", () => {
		releaseCursor?.();
		known.clear();
		loadedAt = 0;
	});
}
