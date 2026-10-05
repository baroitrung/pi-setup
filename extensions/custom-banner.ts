import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

const BANNER = [
	"░▀█▀░█░█▄░█░█▄█░▀█▀░█▒█░▀█▀▒██▀░░",
	"░▒█▒░█░█▒▀█▒█▒█░▒█▒░▀▄█░▒█▒░█▄▄▒░",
];

function center(text: string, width: number): string {
	const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
	if (width <= visible) return text;
	const pad = Math.floor((width - visible) / 2);
	return " ".repeat(pad) + text;
}

class CustomBannerHeader {
	private expanded = false;
	private theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [""];
		const t = this.theme;

		if (width >= 35) {
			for (const line of BANNER) {
				lines.push(center(t.fg("accent", line), width));
			}
		} else {
			lines.push(center(t.bold(t.fg("accent", "◆ TINHTUTE ◆")), width));
		}

		lines.push("");
		const subtitle = `${t.bold(t.fg("accent", "pi"))} ${t.fg("dim", `v${VERSION ?? "0.85.1"}`)} · ${t.fg("muted", "minimal coding agent")}`;
		lines.push(center(subtitle, width));

		if (this.expanded) {
			lines.push("");
			lines.push(center(t.bold("Keyboard Shortcuts"), width));
			lines.push("");
			const shortcuts = [
				["Ctrl+C", "Interrupt / Clear"],
				["Ctrl+D", "Exit (when editor is empty)"],
				["Ctrl+O", "Toggle expand header & tools"],
				["Ctrl+T", "Cycle thinking level"],
				["Ctrl+P / Shift+P", "Cycle models forward / backward"],
				["Ctrl+M", "Select model dialog"],
				["Ctrl+G", "Open in external editor"],
				["/", "Slash commands menu"],
				["!", "Run bash command in terminal"],
				["Alt+Enter", "Queue follow-up message"],
				["Ctrl+V", "Paste image from clipboard"],
			];
			for (const [key, desc] of shortcuts) {
				const item = `  ${t.fg("accent", key.padEnd(18))} ${t.fg("muted", desc)}`;
				lines.push(width > 50 ? center(item, width) : item);
			}
		} else {
			const hints = `${t.fg("dim", "Ctrl+C interrupt · / commands · ! bash · Ctrl+O more")}`;
			lines.push(center(hints, width));
		}

		lines.push("");
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const applyHeader = (ctx: any) => {
		if (ctx.mode === "tui") {
			ctx.ui.setHeader((_tui: any, theme: Theme) => new CustomBannerHeader(theme));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		applyHeader(ctx);
	});

	pi.registerCommand("builtin-header", {
		description: "Restore built-in default Pi header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});

	pi.registerCommand("custom-header", {
		description: "Show custom TINHTUTE banner header",
		handler: async (_args, ctx) => {
			applyHeader(ctx);
			ctx.ui.notify("Custom TINHTUTE banner restored", "info");
		},
	});
}
