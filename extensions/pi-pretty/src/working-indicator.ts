/**
 * Working indicator, thinking label, and their host installation.
 *
 * This file is a barrel: the implementation lives in `./indicator/`, split by
 * concern so a change to the shimmer frames cannot touch the thinking timer.
 * Every symbol that used to be declared here is still exported from here, so
 * `index.ts` and the tests import from the same path as before.
 *
 * Layout:
 *   indicator/types.ts             shared shapes
 *   indicator/env.ts               env flag parsing
 *   indicator/frames.ts            sweep tunables + frame builder
 *   indicator/settings.ts          working-row config resolution
 *   indicator/palette.ts           palette -> ANSI
 *   indicator/thinking-settings.ts hidden-thinking config resolution
 *   indicator/thinking-label.ts    label animation + per-row patch
 *   indicator/widget.ts            legacy zero-padding fallback
 *   indicator/install.ts           install on embedded vs legacy host
 *   indicator/gradient.ts          animate the host's own status labels
 */

export * from "./indicator/env.js";
export * from "./indicator/frames.js";
export * from "./indicator/gradient.js";
export * from "./indicator/install.js";
export * from "./indicator/palette.js";
export * from "./indicator/settings.js";
export * from "./indicator/thinking-label.js";
export * from "./indicator/thinking-settings.js";
export * from "./indicator/types.js";
export * from "./indicator/widget.js";
