/**
 * `/fff-health` and `/fff-rescan`: diagnostics for the bundled FFF indexer.
 *
 * Commands only exist when a finder was created, so nothing here runs on a host
 * where FFF is unavailable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FffService } from "../fff.js";

export function registerFffCommands(pi: ExtensionAPI, fffService: FffService | null): void {
	if (!fffService) return;

	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and indexer status",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const fff = fffService;
			if (!fff || !fff.isAvailable) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}
			const finder = fff.getFinder();
			if (!finder) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}
			const health = finder.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`Health check failed: ${health.error}`, "error");
				return;
			}
			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
				`Partial index: ${fff.partialIndex ? "yes (scan timed out)" : "no"}`,
			];
			const progress = finder.getScanProgress();
			if (progress.ok) {
				lines.push(`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const fff = fffService;
			if (!fff.isAvailable) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}
			const finder = fff.getFinder();
			if (!finder) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}
			const result = finder.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
				return;
			}
			fff.partialIndex = false;
			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
