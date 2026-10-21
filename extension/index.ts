/**
 * pi-model-costs — per-1M-token pricing in Pi's model picker.
 *
 * The pricing layout (in/out, cache read/write, tiers, context window, max
 * output, Tab all/scoped) is from MaurizioFaeddaDev/model-costs (MIT, (c) 2025
 * Maurizio Faedda). The `/model` override approach via editor submit wrapping
 * is guided by shakthi-sagar/pi-extensions packages/pi-model-costs (MIT).
 *
 * Two modes (`piModelCosts.mode` in pi settings, or `PI_MODEL_COSTS_MODE`):
 *
 *   "override" (default) — replaces the built-in `/model` selector in
 *     interactive mode. Same interaction model as the stock picker: up/down
 *     (and ctrl+n/ctrl+p) navigate, type to fuzzy-filter, enter selects,
 *     ctrl+s saves the model as default, esc/ctrl+c cancel, Tab toggles
 *     all/scoped. Keybindings follow pi's keybindings.json via
 *     getKeybindings(). Works with custom providers registered through
 *     pi.registerProvider: the picker re-feeds once the registry refresh
 *     completes.
 *
 *   "command" — leaves `/model` stock and registers a new `/model-costs`
 *     command; `/model-costs <search>` opens the picker pre-filtered.
 *
 * Scope: only the picker. No footer status, no startup UI, no cost sorting.
 *
 * Why an editor wrapper (override mode): pi's interactive mode intercepts
 * `/model` in the editor's onSubmit before extension commands dispatch, and a
 * `pi.registerCommand("model", ...)` clash is renamed to `/model:2`. So the
 * only way to show pricing in `/model` is to wrap the editor submit and render
 * our own picker.
 */

import type { Api, Model, ModelCostTier, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor, DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readModelCostsConfig, type ModelCostsMode } from "./config.ts";

/**
 * pi's editor factory type (stolen set-editor sits between the UI host and any
 * installed editor factory). Derived from ExtensionUIContext because
 * EditorFactory is not publicly exported by pi-coding-agent.
 */
type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function trimZeros(s: string): string {
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Cost rates are USD per 1M tokens. */
function money(n: number): string {
	if (n === 0) return "0";
	if (n >= 100) return n.toFixed(0);
	if (n >= 1) return trimZeros(n.toFixed(2));
	return trimZeros(n.toFixed(3));
}

function tokens(n: number): string {
	if (n >= 1_000_000) return `${trimZeros((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return `${n}`;
}

function isFree(model: Model<Api>): boolean {
	const c = model.cost;
	return c.input === 0 && c.output === 0 && c.cacheRead === 0 && c.cacheWrite === 0 && !c.tiers?.length;
}

/** Compact "$in/$out" used for fuzzy matching. */
function compactCost(model: Model<Api>): string {
	if (isFree(model)) return "free";
	return `$${money(model.cost.input)}/$${money(model.cost.output)}`;
}

function sameModel(a: Model<Api> | undefined, b: Model<Api>): boolean {
	return !!a && a.provider === b.provider && a.id === b.id;
}

// ---------------------------------------------------------------------------
// Default model/provider persistence (built-in ctrl+s parity)
// ---------------------------------------------------------------------------

function settingsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "settings.json");
}

/** Merge-write defaultProvider/defaultModel into the global settings file. */
function persistDefaultModel(model: Model<Api>): void {
	const path = settingsPath();
	let settings: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
	} catch {
		// Missing or unreadable: start from an empty object and write fresh.
	}
	settings.defaultProvider = model.provider;
	settings.defaultModel = model.id;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	} catch {
		// Best-effort; the session model still changes even if the write fails.
	}
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/** `ScopedModel.thinkingLevel` uses pi-coding-agent's ThinkingLevel, which also allows "off". */
type PickerThinkingLevel = ThinkingLevel | "off";

interface ModelItem {
	model: Model<Api>;
	thinkingLevel?: PickerThinkingLevel;
}

interface Picked {
	model: Model<Api>;
	thinkingLevel?: PickerThinkingLevel;
	/** Built-in parity: ctrl+s selects and persists the model as the default. */
	saveAsDefault?: boolean;
}

class ModelCostPicker extends Container implements Focusable {
	private searchInput = new Input();
	private listContainer = new Container();
	private detailContainer = new Container();

	// Focusable: propagate focus to the embedded input for IME positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private allItems!: ModelItem[];
	private scopedItems!: ModelItem[];
	private activeItems!: ModelItem[];
	private filtered!: ModelItem[];
	private selectedIndex = 0;
	private scope: "all" | "scoped" = "all";
	private scopeText: Text | undefined;
	private uiReady = false;

	constructor(
		private tui: import("@earendil-works/pi-tui").TUI,
		private theme: Theme,
		private currentModel: Model<Api> | undefined,
		scopedModels: readonly { model: Model<Api>; thinkingLevel?: PickerThinkingLevel }[],
		availableModels: readonly Model<Api>[],
		initialQuery: string | undefined,
		private defaultModel: Model<Api> | undefined,
		private done: (value: Picked | null) => void,
	) {
		super();

		this.setModels(availableModels, scopedModels);

		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		if (this.scopedItems.length > 0) {
			this.scopeText = new Text(this.renderScopeText(), 0, 0);
			this.addChild(this.scopeText);
		} else {
			this.addChild(
				new Text(theme.fg("muted", "  Only configured providers are shown. Use /login to add more."), 0, 0),
			);
		}

		this.searchInput.onSubmit = () => {
			const item = this.filtered[this.selectedIndex];
			if (item) this.select(item);
		};
		if (initialQuery) this.searchInput.setValue(initialQuery);
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.addChild(this.listContainer);
		this.addChild(this.detailContainer);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		const currentIndex = this.activeItems.findIndex((item) => sameModel(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.uiReady = true;
		this.applyFilter(initialQuery ?? "");
	}

	/**
	 * Replace the model lists. Custom providers registered via pi.registerProvider
	 * land in the registry snapshot asynchronously (registerProvider fires a
	 * background refresh), so the picker is re-fed once that refresh completes.
	 * Preserves scope, query and selection.
	 */
	setModels(
		availableModels: readonly Model<Api>[],
		scopedModels: readonly { model: Model<Api>; thinkingLevel?: PickerThinkingLevel }[] = this.scopedItems ?? [],
	): void {
		const initialized = this.uiReady;
		const hadScoped = initialized && this.scopedItems.length > 0;
		const query = initialized ? this.searchInput.getValue() : "";
		const prevSelected = initialized ? this.filtered[this.selectedIndex]?.model : undefined;

		this.allItems = this.orderItems(availableModels.map((model) => ({ model })));
		this.scopedItems = this.orderItems([...scopedModels]);
		if (!hadScoped) this.scope = this.scopedItems.length > 0 ? "scoped" : "all";
		this.activeItems = this.scope === "scoped" ? this.scopedItems : this.allItems;
		this.filtered = this.activeItems;

		// Constructor pre-init call: leave selection setup to the constructor,
		// which places it on the current model once the list is built.
		if (!initialized) return;

		// Re-resolve the previously highlighted model so a background refresh
		// doesn't yank the cursor back to the top of the list.
		this.applyFilter(query);
		if (prevSelected) {
			const idx = this.filtered.findIndex((item) => sameModel(prevSelected, item.model));
			if (idx >= 0) this.selectedIndex = idx;
		} else {
			const currentIndex = this.filtered.findIndex((item) => sameModel(this.currentModel, item.model));
			if (currentIndex >= 0) this.selectedIndex = currentIndex;
		}
		if (this.scopeText) this.scopeText.setText(this.renderScopeText());
		this.updateList();
	}

	/** Default order: current model first, then provider, then id. */
	private orderItems(items: ModelItem[]): ModelItem[] {
		return [...items].sort((a, b) => {
			const aCurrent = sameModel(this.currentModel, a.model);
			const bCurrent = sameModel(this.currentModel, b.model);
			if (aCurrent && !bCurrent) return -1;
			if (!aCurrent && bCurrent) return 1;
			const byProvider = a.model.provider.localeCompare(b.model.provider);
			return byProvider !== 0 ? byProvider : a.model.id.localeCompare(b.model.id);
		});
	}

	private renderScopeText(): string {
		const all = this.scope === "all" ? this.theme.fg("accent", "all") : this.theme.fg("muted", "all");
		const scoped = this.scope === "scoped" ? this.theme.fg("accent", "scoped") : this.theme.fg("muted", "scoped");
		return `${this.theme.fg("muted", "  Scope: ")}${all}${this.theme.fg("muted", " | ")}${scoped}${this.theme.fg("dim", `  (${keyText("tui.input.tab")} to toggle)`)}`;
	}

	private applyFilter(query: string): void {
		if (query) {
			this.filtered = fuzzyFilter(this.activeItems, query, (item) =>
				`${item.model.provider}/${item.model.id} ${item.model.name} ${compactCost(item.model)}`,
			);
			this.selectedIndex = 0;
		} else {
			this.filtered = this.activeItems;
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		}
		this.updateList();
	}

	private updateList(): void {
		const theme = this.theme;
		this.listContainer.clear();
		this.detailContainer.clear();

		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent = sameModel(this.currentModel, item.model);

			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const idText = isSelected ? theme.fg("accent", item.model.id) : item.model.id;
			const providerBadge = theme.fg("muted", ` [${item.model.provider}]`);
			const cost = isFree(item.model)
				? theme.fg("success", "free")
				: theme.fg("warning", `$${money(item.model.cost.input)}/$${money(item.model.cost.output)}`);
			const ctx = theme.fg("dim", ` · ${tokens(item.model.contextWindow)} ctx`);
			const check = isCurrent ? theme.fg("success", " ✓") : "";
			const defaultBadge = sameModel(this.defaultModel, item.model) ? theme.fg("muted", " · default") : "";

			this.listContainer.addChild(new Text(`${prefix}${idText}${providerBadge} ${cost}${ctx}${check}${defaultBadge}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filtered.length) {
			this.listContainer.addChild(
				new Text(theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
			);
		}

		this.renderDetails(this.filtered[this.selectedIndex]?.model);
	}

	private renderDetails(model: Model<Api> | undefined): void {
		if (!model) return;
		const theme = this.theme;
		const c = model.cost;

		this.detailContainer.addChild(new Spacer(1));

		if (isFree(model)) {
			this.detailContainer.addChild(new Text(theme.fg("success", `  free — no per-token cost`), 0, 0));
		} else {
			let line = `  ${theme.fg("warning", `$${money(c.input)}`)} in · ${theme.fg("warning", `$${money(c.output)}`)} out`;
			if (c.cacheRead > 0 || c.cacheWrite > 0) {
				line += theme.fg("muted", ` · cache $${money(c.cacheRead)} read / $${money(c.cacheWrite)} write`);
			}
			line += theme.fg("dim", "  (per 1M tokens)");
			this.detailContainer.addChild(new Text(line, 0, 0));

			for (const tier of c.tiers ?? []) {
				this.detailContainer.addChild(
					new Text(
						theme.fg(
							"muted",
							`  above ${tokens((tier as ModelCostTier).inputTokensAbove)} input tok: $${money(tier.input)}/$${money(tier.output)} · cache $${money(tier.cacheRead)}/$${money(tier.cacheWrite)}`,
						),
						0,
						0,
					),
				);
			}
		}

		const tags: string[] = [];
		if (model.reasoning) tags.push("reasoning");
		tags.push(model.input.includes("image") ? "text+image" : "text");
		this.detailContainer.addChild(
			new Text(
				theme.fg(
					"muted",
					`  ${model.name} · ${tokens(model.contextWindow)} ctx · ${tokens(model.maxTokens)} max out · ${tags.join(" · ")}`,
				),
				0,
				0,
			),
		);
	}

	private select(item: ModelItem, saveAsDefault = false): void {
		this.done({ model: item.model, thinkingLevel: item.thinkingLevel, saveAsDefault });
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const query = this.searchInput.getValue();

		if (kb.matches(data, "tui.input.tab") && this.scopedItems.length > 0) {
			this.scope = this.scope === "all" ? "scoped" : "all";
			this.activeItems = this.scope === "scoped" ? this.scopedItems : this.allItems;
			const currentIndex = this.activeItems.findIndex((item) => sameModel(this.currentModel, item.model));
			this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
			if (this.scopeText) this.scopeText.setText(this.renderScopeText());
			this.applyFilter(query);
		} else if (kb.matches(data, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.select(item);
			return;
		} else if (kb.matches(data, "app.models.save")) {
			const item = this.filtered[this.selectedIndex];
			if (item) this.select(item, true);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const mode: ModelCostsMode = readModelCostsConfig(".").mode;

	// Override mode keeps the freshest session context (session_start re-fires
	// on session switch/reload); command mode uses the handler's ctx instead.
	let latestCtx: ExtensionContext | undefined;

	/** Built-in parity: `/model provider/id` (or unique id) switches directly. */
	function findExact(search: string, ctx: ExtensionContext): ModelItem | undefined {
		const norm = search.trim();
		if (!norm) return undefined;
		const scoped = [...ctx.scopedModels];
		const pool: ModelItem[] = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
		for (const item of pool) {
			if (`${item.model.provider}/${item.model.id}` === norm) return item;
		}
		const byId = pool.filter((i) => i.model.id === norm);
		if (byId.length === 1) return byId[0];
		const lower = norm.toLowerCase();
		for (const item of pool) {
			if (`${item.model.provider}/${item.model.id}`.toLowerCase() === lower) return item;
		}
		const byIdLower = pool.filter((i) => i.model.id.toLowerCase() === lower);
		if (byIdLower.length === 1) return byIdLower[0];
		return undefined;
	}

	async function applySelection(picked: Picked, ctx: ExtensionContext): Promise<void> {
		const success = await pi.setModel(picked.model);
		if (!success) {
			ctx.ui.notify(`No API key configured for provider "${picked.model.provider}"`, "error");
			return;
		}
		if (picked.thinkingLevel) {
			pi.setThinkingLevel(picked.thinkingLevel);
		}
		if (picked.saveAsDefault) {
			persistDefaultModel(picked.model);
			ctx.ui.notify(`Default model: ${picked.model.provider}/${picked.model.id}`, "info");
		}
	}

	async function handleModelCommand(search: string | undefined, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The pricing-aware picker requires the interactive TUI.", "warning");
			return;
		}

		// Fast path: exact reference switches without opening the picker.
		if (search) {
			const exact = findExact(search, ctx);
			if (exact) {
				await applySelection(exact, ctx);
				return;
			}
		}

		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("No models available — check /login", "warning");
			return;
		}

		const picked = await ctx.ui.custom<Picked | null>((tui, theme, _kb, done) => {
			const settings = pi.getSettings() as { defaultProvider?: string; defaultModel?: string };
			const defaultModel = settings.defaultProvider && settings.defaultModel
				? models.find((m) => m.provider === settings.defaultProvider && m.id === settings.defaultModel)
				: undefined;
			const picker = new ModelCostPicker(tui, theme, ctx.model, ctx.scopedModels, models, search, defaultModel, done);
			// Custom providers register asynchronously; refresh and re-feed the list
			// once the registry snapshot catches up (same idea as the built-in picker).
			void ctx.modelRegistry
				.refresh({ allowNetwork: true })
				.then(() => picker.setModels(ctx.modelRegistry.getAvailable(), ctx.scopedModels))
				.catch(() => {
					// Network/catalog errors are non-fatal: keep the snapshot we already have.
				});
			return picker;
		});
		if (!picked) return;
		await applySelection(picked, ctx);
	}

	/** Wrap one editor instance's submit to steal only `/model`. */
	function wrapSubmit(editor: EditorComponent): void {
		const anyEditor = editor as unknown as Record<string, unknown>;
		if (anyEditor.__modelCostsSubmitWrapped) return;
		anyEditor.__modelCostsSubmitWrapped = true;
		const native = (editor.onSubmit ?? (() => {})).bind(editor);
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (trimmed === "/model" || trimmed.startsWith("/model ")) {
				const search = trimmed.startsWith("/model ") ? trimmed.slice(7).trim() || undefined : undefined;
				editor.setText("");
				if (latestCtx) void handleModelCommand(search, latestCtx);
				return;
			}
			native(text);
		};
	}

	/**
	 * Chain with whatever editor factory is currently installed (e.g. pi-vim):
	 * create the inner editor, let pi wire its onSubmit, then wrap submit.
	 * Future setEditorComponent calls (e.g. /vim toggle) are re-wrapped via the
	 * patched setter, so neither extension clobbers the other.
	 */
	function ensureIntercept(ctx: ExtensionContext): void {
		const ui = ctx.ui;
		const anyUi = ui as unknown as Record<string, unknown>;

		if (!anyUi.__modelCostsSetterPatched) {
			anyUi.__modelCostsSetterPatched = true;
			const origSet = ui.setEditorComponent.bind(ui);
			const patchedSet = (factory: EditorFactory | undefined) => {
				if (!factory) {
					// "Restore default" still keeps the /model intercept.
					let inner: EditorComponent | undefined;
					const wrapped = ((tui: unknown, theme: unknown, kb: unknown) => {
						inner = new CustomEditor(tui as never, theme as never, kb as never);
						return inner;
					}) as unknown as EditorFactory;
					(wrapped as unknown as Record<string, unknown>).__modelCostsFactory = true;
					origSet(wrapped);
					if (inner) wrapSubmit(inner);
					return;
				}
				if ((factory as unknown as Record<string, unknown>).__modelCostsFactory) {
					origSet(factory);
					return;
				}
				let inner: EditorComponent | undefined;
				const wrapped = ((tui: unknown, theme: unknown, kb: unknown) => {
					inner = (factory as unknown as (t: unknown, th: unknown, k: unknown) => EditorComponent)(tui, theme, kb);
					return inner;
				}) as unknown as EditorFactory;
				(wrapped as unknown as Record<string, unknown>).__modelCostsFactory = true;
				origSet(wrapped);
				if (inner) wrapSubmit(inner);
			};
			(ui as unknown as { setEditorComponent: typeof ui.setEditorComponent }).setEditorComponent = patchedSet;
		}

		const current = ui.getEditorComponent();
		if (current && (current as unknown as Record<string, unknown>).__modelCostsFactory) return;
		(anyUi.setEditorComponent as (f: EditorFactory | undefined) => void)(current ?? undefined);
	}

	if (mode === "command") {
		// Register a fresh command instead of touching `/model`. Handler ctx is
		// a full ExtensionContext, so the picker works from here too.
		pi.registerCommand("model-costs", {
			description: "Model picker with per-1M-token pricing",
			handler: async (args, ctx) => {
				await handleModelCommand(args.trim() || undefined, ctx);
			},
		});
		return;
	}

	// Override mode (default): intercept `/model` in the editor submit.
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.mode === "tui") ensureIntercept(ctx);
	});
}
