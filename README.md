# pi-model-costs

Per-1M-token pricing in [pi](https://github.com/earendil-works/pi)'s model picker — visible before
you switch, so you know what your next prompt will cost.

Works in **two modes**:

- **`override` (default)** — replaces the built-in `/model` selector with the pricing-aware picker,
  keeping the stock interaction model: fuzzy filter, `↑/↓` navigation, `Tab` all/scoped, `ctrl+s`
  save-as-default, and keybindings read from your `keybindings.json`.
- **`command`** — leaves `/model` untouched and registers a new `/model-costs` command instead
  (`/model-costs <search>` opens the picker pre-filtered, `/model-costs provider/id` switches
  directly).

Both modes include models from **custom providers** registered via `pi.registerProvider` — the
picker re-arms after the registry refresh completes, so custom providers and custom `models.json`
entries show up with their pricing too.

The picker shows, per model:

```
→ sonnet-4-5 [anthropic] $3/$15 · 200k ctx ✓ · default
  $3 in · $15 out · cache $0.3 read / $3.75 write (per 1M tokens)
  … sonnet-4-5 · 200k ctx · 64k max out · reasoning · text+image
```

Free models show as `free`; tiered long-context pricing is listed per tier.

## Install

```bash
pi install npm:@banh-me/pi-model-costs
```

Alternatives:

```bash
# pin a version / install project-only
pi install npm:@banh-me/pi-model-costs@0.1.0
pi install npm:@banh-me/pi-model-costs -l

# from git
pi install git:github.com/banh-me/pi-model-costs

# or try it for one run without installing
pi -e npm:@banh-me/pi-model-costs
```

Restart pi after install (or run `/reload`).

## Configuration

Options live in the `piModelCosts` section of pi settings — global `~/.pi/agent/settings.json`, or
per-project `<cwd>/.pi/settings.json` (project keys override global):

```jsonc
{
  "piModelCosts": {
    // "override" (default) — replace the built-in /model picker with the
    //                       pricing-aware one
    // "command"             — don't touch /model; register /model-costs instead
    // Aliases accepted: "override" | "replace" | "builtin" | "model" and
    // "command" | "model-costs" | "register" | "add"
    "mode": "override"
  }
}
```

For one run without editing settings, set `PI_MODEL_COSTS_MODE` (`override` or `command`) in the
environment — it wins over settings. Handy with `pi -e`:

```bash
PI_MODEL_COSTS_MODE=command pi -e npm:@banh-me/pi-model-costs
```

### Behavior notes

- Override mode wraps the editor's submit path so it only intercepts `/model`; every other command
  and prompt passes through untouched. It chains with other custom editors (e.g. pi-vim) — enabling
  or disabling another editor at runtime re-wraps cleanly, neither extension clobbers the other.
- Only interactive (`tui`) mode shows the picker; print/RPC invocations get a notice instead.
- The actual switch still goes through pi's normal `setModel` path, so API keys resolve exactly as
  the stock `/model` would.

## How this differs from other model-costs extensions

This package stands on two earlier works — **[MaurizioFaeddaDev/model-costs](https://github.com/MaurizioFaeddaDev/model-costs)**
and **[shakthi-sagar/pi-extensions `pi-model-costs`](https://github.com/shakthi-sagar/pi-extensions/tree/main/packages/pi-model-costs)**
(see [Attribution](#attribution)), and is intentionally a different point on the simplicity axis:

| | `@banh-me/pi-model-costs` (this) | [`pi-model-costs`](https://www.npmjs.com/package/pi-model-costs) (Maurizio Faedda) | [`pi-model-cost`](https://www.npmjs.com/package/pi-model-cost) (Shakthi Sagar) |
|---|---|---|---|
| Where pricing appears | in the built-in `/model` picker itself (or optional `/model-costs`) | separate `/model-cost` command + footer status | inline in every `/model` row |
| How `/model` is handled | submit-intercept on the built-in editor — picked up by keybindings.json | separate picker with its own flow (ctrl+s cost sorting) | replaces the editor with the stock `CustomEditor` to intercept `/model` |
| Footer status | none | on by default (source flag) | none |
| Cost sorting | none | cycles default/in/out/total sorts | none |
| Tiered pricing | shown per tier in the detail pane | shown | not shown (base rates only) |
| Custom providers | picked up mid-session — list re-fed after registry refresh | not re-fed after a `registerProvider` refresh | not re-fed after a `registerProvider` refresh |

The differences in short:

1. **`/model` itself gets pricing** — you keep the one command you already type, with the built-in
   picker's exact interaction model (fuzzy filter over `provider/id name $in/$out`, `Tab`
   all/scoped, `ctrl+s` sets `defaultProvider`/`defaultModel` in settings.json, message
   on missing API keys). If you'd rather keep `/model` stock, `mode: "command"` gives you
   `/model-costs` instead — no editor replacement needed in that mode.
2. **Custom-provider friendly** — providers added with `pi.registerProvider` (or custom
   `models.json` entries) arrive in the registry asynchronously; the picker listens for the refresh
   and re-feeds its list, preserving scope, query and cursor.
3. **Deliberately simple** — no footer status, no cost sorting, no startup UI, no configuration
   beyond one option. It shows pricing in the picker and that's it.

## Attribution

- **[MaurizioFaeddaDev/model-costs](https://github.com/MaurizioFaeddaDev/model-costs)** (MIT © 2025
  Maurizio Faedda) — the pricing presentation derives from its picker: in/out rates, cache
  read/write rates, pricing tiers, context window, max output tokens, and the `Tab` all/scoped
  toggle.
- **[shakthi-sagar/pi-extensions — `packages/pi-model-costs`](https://github.com/shakthi-sagar/pi-extensions/tree/main/packages/pi-model-costs)**
  (MIT) — the idea of showing pricing *inside* Pi's own `/model` via an editor-wrapped intercept,
  and the single-file extension package layout used as reference.

Both were used as references; this implementation is original code.

## Development

```bash
npm install
npm run typecheck
```

Runtime dependencies (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`) are host-provided and declared as peer dependencies; only devDependencies
are installed for typechecking.

Releases: publish to npm happens automatically from GitHub Actions ([workflows/publish.yml](.github/workflows/publish.yml))
via npm trusted publishing (OIDC) whenever a release is tagged `v<package.json version>`.

## License

MIT
