# OpenDesign X

A Windows-first reconstruction and extension of [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0), built as a **real installable desktop application** — not a mockup.

This repository is a **patch repository**. It does not mirror upstream source. It contains:

- [`changed-files/`](changed-files/) — the complete modified files, at their real repository paths
- [`0001-win-packaged-main-cjs-and-providers.patch`](0001-win-packaged-main-cjs-and-providers.patch) — the same work as a `git am`-able patch
- `docs/` — investigation notes, the test plan, and the stage log

Apply against upstream pinned at commit [`78d5637`](https://github.com/nexu-io/open-design/commit/78d5637cb49da07e81314d1544b5fc6d37c95084) (version `0.25.1`).

```bash
git clone https://github.com/nexu-io/open-design.git
cd open-design
git checkout 78d5637cb49da07e81314d1544b5fc6d37c95084
git am /path/to/0001-win-packaged-main-cjs-and-providers.patch
```

---

## Status

Work proceeds in stages. Each stage ships functional software.

| Stage | Scope | Status |
|---|---|---|
| **A** | Real installable Windows `.exe` | 🔶 Unpacked build green; NSIS installer blocked |
| **B** | Preserve daemon, auth, agents, external APIs | ⬜ Not started |
| **C** | New interface: onboarding, home, Studio, model config | ⬜ Not started |
| **C2** | Full dark mode across shell, chat, viewer, home | ⬜ Not started |
| **D** | AI element editing, references, history, projects, terminal | ⬜ Not started |
| **E** | Bug fixes, 12-flow validation, installer | ⬜ Not started |

Nothing is marked done unless it was built and executed.

---

## What is implemented

### 1. Packaged Electron main starts (critical fix)

The Windows packaged build died on launch with no window and no visible error. The
installed `Open Design.exe` exited immediately, and the sidecar named pipes never
bound.

**Cause.** `tools/pack` bundled the packaged Electron main as **ESM** while marking
`electron` external. Because `apps/packaged` imports Electron bindings by name:

```ts
import { app, dialog } from "electron";
```

esbuild emitted native ESM named imports. `electron` is a CommonJS module that
exposes no named ESM exports, so Electron's ESM loader rejected the module:

```
SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
```

The app's own error handler caught that and reported *"Open Design could not start"*,
then exited — before any sidecar or window was created.

**Fix.** Bundle the packaged main as **CJS** rather than ESM. Electron's main process
is CommonJS by default, so `require("electron")` resolves natively and the named
bindings become property access on Electron's own API object.

Verified in the shipped artifact: `packaged-main.cjs` emits `require("electron")`
with **zero** remaining ESM named imports of `electron`.

Two alternative fixes were implemented and rejected on evidence:

- **esbuild `--alias` shim** — the alias also rewrote the shim's own `electron`
  specifier, making the module require itself and recurse.
- **`createRequire` shim** — Node's CJS resolver does not know Electron's built-in
  `electron` module, so it threw `MODULE_NOT_FOUND`.

Files: [`tools/pack/src/win/app.ts`](changed-files/tools/pack/src/win/app.ts),
[`tools/pack/src/win/prebundle.ts`](changed-files/tools/pack/src/win/prebundle.ts),
[`tools/pack/src/launcher/packaged-entry.ts`](changed-files/tools/pack/src/launcher/packaged-entry.ts)

### 2. Windows NSIS build unblocked at the toolchain level

electron-builder's Go `app-builder` extracts `winCodeSign-2.6.0.7z`, which contains
two macOS symlinks. Without `SeCreateSymbolicLinkPrivilege`, 7-Zip fails with
`Cannot create symbolic link` and the installer build aborts.

The workaround seeds a pristine, checksum-valid kit from the electron-builder cache
and serves it over a loopback HTTP mirror, so extraction never has to create the
symlinks. Serving a **repacked symlink-free** archive does not work — electron-builder
verifies the archive sha512, so the archive must be byte-identical.

Files: [`tools/pack/src/win/builder.ts`](changed-files/tools/pack/src/win/builder.ts)

> **Still blocked.** The mirror approach handles the checksum and the kit, but the
> NSIS lane additionally needs the symbolic-link privilege itself. Enabling Windows
> Developer Mode grants it at logon, so it requires a sign-out/sign-in to take effect.
> The `--to dir` lane bypasses NSIS entirely and builds green.

### 3. Three additional model providers

Added to the web provider catalog so the model system covers more of the
OpenAI-compatible ecosystem:

| Provider | Protocol | Base URL |
|---|---|---|
| Groq | OpenAI | `https://api.groq.com/openai/v1` |
| Fireworks AI | OpenAI | `https://api.fireworks.ai/inference/v1` |
| LM Studio (local) | OpenAI | `http://127.0.0.1:1234/v1` |

LM Studio is marked `requiresApiKey: false`, since local endpoints do not require
bearer credentials. Provider options are filtered by the selected protocol, so these
appear on the OpenAI tab.

File: [`apps/web/src/state/config.ts`](changed-files/apps/web/src/state/config.ts)

---

## Validation

Run from a checkout with the patch applied:

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/tools-pack test
pnpm --filter @open-design/tools-pack build
pnpm tools-pack win build --dir C:\odx-dir --namespace odx --to dir --json
```

Measured results:

| Check | Result |
|---|---|
| `pnpm guard` | exit 0 |
| `pnpm typecheck` | exit 0, no errors |
| `tools-pack` test suite | `6 failed \| 38 passed` (44 files), `13 failed \| 328 passed \| 5 skipped` (346 tests) |
| `win build --to dir` | exit 0, all phases green |

The failing tests are **pre-existing and environmental**, proven by stashing the
changes and reproducing identical counts on unmodified upstream:

- 7-Zip `System ERROR: Access is denied` on payload archives
- macOS notarization tests running on Windows
- Windows launcher payload tests requiring the symlink privilege

This change introduces **zero** new failures.

### Verified versus unverified

**Verified:** the bundle's `electron` resolution, the build pipeline, `guard`,
`typecheck`, the test baseline, and the artifact contents.

**Not verified:** that the packaged app renders a window. In this development
environment, launching `Open Design.exe` produced no process and no output — and a
three-line minimal Electron app with no product code failed identically, never
executing its first line. The binary itself works (`--version` responds,
`ELECTRON_RUN_AS_NODE` file writes succeed), so this is Chromium GUI initialization
failing in a non-interactive shell rather than a defect in the package.

**The final launch check must be performed by a person on a normal desktop session.**

---

## License

The upstream project is licensed under the **Apache License 2.0**. See
[`NOTICE`](NOTICE) for attribution and [`ORIGINAL-MODS-LICENSE.txt`](ORIGINAL-MODS-LICENSE.txt)
for the terms covering the original modifications.

This repository contains only original modifications. It deliberately does not
redistribute upstream source, upstream git history, or contributor identities.
Pinned to upstream commit `78d5637cb49da07e81314d1544b5fc6d37c95084`.

The files under [`changed-files/`](changed-files/) are modified versions of upstream
files and remain subject to the upstream Apache License 2.0. The modifications
themselves are also released under the Apache License 2.0.
