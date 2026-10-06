import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const BAR_CELLS = 8;

// Model names and branch names are labels, never terminal control sequences.
function label(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export default function (pi: ExtensionAPI) {
	const applyFooter = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			const unsubscribe = [
				footerData.onBranchChange(requestRender),
				pi.on("model_select", requestRender),
				pi.on("thinking_level_select", requestRender),
			];
			let disposed = false;

			return {
				invalidate() {},
				dispose() {
					if (disposed) return;
					disposed = true;
					for (const unsub of unsubscribe) unsub();
				},
				render(width: number): string[] {
					const model = label(ctx.model?.name || ctx.model?.id || "no model");
					const thinking = pi.getThinkingLevel();
					const usage = ctx.getContextUsage()?.percent;
					const percent = typeof usage === "number" && Number.isFinite(usage)
						? Math.max(0, Math.min(100, usage))
						: undefined;
					const filled = Math.round(((percent ?? 0) / 100) * BAR_CELLS);
					const bar = "━".repeat(filled) + "─".repeat(BAR_CELLS - filled);
					const contextColor = percent === undefined ? "dim"
						: percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
					const context = `${bar} ${percent === undefined ? "?" : Math.round(percent)}%`;
					const separator = theme.fg("dim", " · ");
					const parts = [
						theme.bold(theme.fg("accent", `✦ ${model}`)),
						theme.fg("muted", thinking),
						theme.fg(contextColor, context),
					];
					const branch = footerData.getGitBranch();
					if (branch) parts.push(theme.fg("syntaxVariable", `⌥ ${label(branch)}`));

					return [truncateToWidth(` ${parts.join(separator)}`, Math.max(0, width))];
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => applyFooter(ctx));

	pi.registerCommand("custom-footer", {
		description: "Show compact model, thinking, context, and Git footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			applyFooter(ctx);
			ctx.ui.notify("Custom footer restored", "info");
		},
	});

	pi.registerCommand("builtin-footer", {
		description: "Restore the built-in Pi footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			ctx.ui.setFooter(undefined);
			ctx.ui.notify("Built-in footer restored", "info");
		},
	});
}
