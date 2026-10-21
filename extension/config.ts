/**
 * pi-model-costs configuration.
 *
 * Read from the `piModelCosts` section of pi settings files:
 *   global : ~/.pi/agent/settings.json
 *   project: <cwd>/.pi/settings.json   (overrides global per-key)
 *
 * `PI_MODEL_COSTS_MODE` wins over settings when set — handy for trying the
 * other mode for one run without touching settings.
 */

import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type ModelCostsMode =
	/** Replace the built-in `/model` picker with the pricing-aware one (default). */
	| "override"
	/** Leave `/model` stock and register a new `/model-costs` command instead. */
	| "command";

export type ModelCostsConfig = {
	mode: ModelCostsMode;
};

export const DEFAULT_CONFIG: ModelCostsConfig = {
	mode: "override",
};

/** Accepted spellings of the `mode` option. */
const COMMAND_ALIASES = new Set(["command", "model-costs", "modelcosts", "register", "add"]);
const OVERRIDE_ALIASES = new Set(["override", "model", "builtin", "built-in", "replace"]);

function readMode(value: unknown): ModelCostsMode | null {
	if (typeof value !== "string") return null;
	const raw = value.trim().toLowerCase();
	if (COMMAND_ALIASES.has(raw)) return "command";
	if (OVERRIDE_ALIASES.has(raw)) return "override";
	return null; // invalid → falls through to the default
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one settings layer into the config (project over global). */
function applyLayer(config: ModelCostsConfig, section: unknown): void {
	if (!isRecord(section)) return;
	const mode = readMode(section.mode);
	if (mode) config.mode = mode;
}

function applyLayerFile(config: ModelCostsConfig, settings: unknown): void {
	if (!isRecord(settings)) return;
	applyLayer(config, settings.piModelCosts);
}

/**
 * Resolve the active mode. Precedence:
 *   PI_MODEL_COSTS_MODE  >  project settings  >  global settings  >  "override".
 */
export function readModelCostsConfig(cwd: string): ModelCostsConfig {
	const config: ModelCostsConfig = { ...DEFAULT_CONFIG };
	try {
		const manager = SettingsManager.create(cwd);
		applyLayerFile(config, manager.getGlobalSettings());
		applyLayerFile(config, manager.getProjectSettings());
	} catch {
		// Settings unreadable — run on defaults.
	}
	const fromEnv = readMode(process.env.PI_MODEL_COSTS_MODE);
	if (fromEnv) config.mode = fromEnv;
	return config;
}
