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
| **A** | Real installable Windows `.exe` | 🔶 Installer **builds** (422.3 MB, exit 0); install cannot be executed in this environment |
| **B** | Preserve daemon, auth, agents, external APIs | 🔶 Daemon, 318 API routes, agent detection and API-token auth **verified by execution**; connector integrations outstanding |
| **C** | New interface: onboarding, home, Studio, model config | 🔶 Multi-provider model configuration **shipped and verified end-to-end**; onboarding/home/Studio redesign outstanding |
| **C2** | Full dark mode across shell, chat, viewer, home | 🔶 Preference **shipped and verified live** — entry, workspace home, project file panel, chat composer all audited at **zero unadapted surfaces**; four real light-only regressions found and fixed in the process |
| **D** | AI element editing, references, history, projects, terminal | ⬜ Not started |
| **E** | Bug fixes, 12-flow validation, installer | ⬜ Not started |

Nothing is marked done unless it was built and executed.

---

## What is implemented

### 1. Three-path "add a model or provider" wizard

The original UI configured models through a single flat provider dropdown. That
conflated three genuinely different setups — a known hosted gateway, an arbitrary
OpenAI-compatible endpoint, and a local server that needs no key — into one list,
and gave the user no guidance about which one applied to them.

It is replaced by an explicit three-path wizard that asks the question once and
then shows only the fields that path needs:

| Path | What it collects |
|---|---|
| **Provedor conhecido** (recommended) | A pre-configured provider, with the correct base URL and its common models |
| **API personalizada** | Any OpenAI-compatible endpoint the user runs themselves |
| **Modelo local** | A local OpenAI-compatible server, with no API key required |

Implemented as `apps/web/src/components/byok/ByokAddProviderWizard.tsx` and wired
into **both** BYOK surfaces — the onboarding screen (`EntryShell.tsx`) and in-app
settings (`SettingsDialog.tsx`) — replacing the old `ByokProviderPicker`, which is
deleted. Strings are translated in all 19 shipped locales, with pt-BR as the
source language.

**Verified by execution.** Selecting a path drives the real configuration rather
than only repainting:

| Action | Resulting base URL |
|---|---|
| OpenAI-compatible protocol, before choosing | `https://api.openai.com/v1` |
| Choose **DeepSeek** on the known-provider path | `https://api.deepseek.com` |
| Choose **LM Studio (local)** on the local path | `http://127.0.0.1:1234/v1` |

The local path correctly offers only servers that need no key (`vLLM`,
`LM Studio (local)`), and an empty provider list renders an explanation instead
of a dead picker. Eight focused component tests cover the paths, the gating
between steps, and the empty and no-local-preset cases.

### 2. Packaged Electron main starts (critical fix)

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

### 3. Windows NSIS installer now builds

Three independent blockers sat between a green `--to dir` build and a real setup
`.exe`. Only the last was a genuine code defect; the first two were toolchain and
environment, and pinning them down mattered because the obvious diagnoses were wrong.

**(a) `winCodeSign` symlinks.** electron-builder's Go `app-builder` extracts
`winCodeSign-2.6.0.7z`, which contains two macOS symlinks. Without
`SeCreateSymbolicLinkPrivilege`, 7-Zip reports `Cannot create symbolic link`.
It turned out not to be fatal: 83 files still extract, including `signtool.exe`
and `rcedit-x64.exe`, so the Windows kit is complete and signing works. The fix
seeds a pristine, checksum-valid kit from the electron-builder cache and serves it
over a loopback HTTP mirror, so extraction never reaches the symlinks. Serving a
**repacked symlink-free** archive does not work — electron-builder verifies the
archive sha512, so the served archive must be byte-identical.

**(b) `makensis` missing, then read-only.** The build then failed with
`makensis is required to build the Windows installer`. Installing NSIS system-wide
resolved that, but exposed the next problem: the generated script references
`LANG_PERSIAN`, and stock NSIS ships `Farsi.nlf`, not `Persian.nlf`. The existing
alias step copies the file in place, which is impossible under `Program Files` for
a non-elevated user (`EPERM`).

The first attempted fix — copy the whole NSIS tree to a writable path and build
with the staged `makensis.exe` — **made things worse**. The staged binary failed
with `Internal compiler error #12345: error creating mmap the size of 278921220`
on a payload the installed binary compiled fine. Measured side by side on an
identical 250 MB payload:

| `makensis.exe` location | Result |
|---|---|
| `C:\Program Files (x86)\NSIS\` | exit 0, installer produced |
| `<workspace>\.tmp\tools-pack\nsis-staged\` | `error creating mmap` |

So the staging approach was the cause, and it was reverted.

**The actual fix.** `MUI_LANGUAGE` hardcodes `${NSISDIR}\Contrib\Language files`,
but the underlying `MUI_LANGUAGEEX` macro accepts an explicit directory:

```nsis
!insertmacro MUI_LANGUAGEEX "C:\...\nsis-language-alias" "Persian"
```

The build now copies the language files to a writable alias directory, adds
`Persian.nlf` there, and routes **only** the Persian entry through
`MUI_LANGUAGEEX`. Every other language keeps the default path. The installed NSIS
is never modified and no elevation is needed. The in-place alias step also skips
read-only roots instead of failing, since a system-wide NSIS is expected.

Result: `pnpm tools-pack win build --to nsis` completes all ten phases and produces
`Open Design-rg-setup.exe` at 422.3 MB.

Files: [`tools/pack/src/win/builder.ts`](changed-files/tools/pack/src/win/builder.ts),
[`tools/pack/src/win/custom-installer.ts`](changed-files/tools/pack/src/win/custom-installer.ts),
[`tools/pack/src/win/nsis.ts`](changed-files/tools/pack/src/win/nsis.ts)

> **Not yet proven:** the installer builds, but it cannot be *executed* in this
> environment. A minimal control installer — no project code, one `File` and one
> `FileWrite` — returns exit code 0 and never runs its own `Section`, matching the
> same GUI-subsystem restriction that prevents the packaged app from opening a
> window here. Launching the installer and the installed app needs a normal
> interactive desktop session.

### 4. Additional model providers

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

### 5. Stage B: the preserved backend, verified by execution

Requirement 5 was to keep every existing feature. Rather than assert that, the
backend was exercised and its real surface counted.

**Daemon health.** `GET /api/health` returns
`{"ok":true,"version":"0.25.1","amrTerminalReporter":{…}}`.

**Endpoint sweep.** Representative routes confirmed to answer:

| Route | Status |
|---|---|
| `/api/health`, `/api/agents`, `/api/app-config`, `/api/projects` | 200 |
| `/api/daemon/db`, `/api/atoms`, `/api/craft` | 200 |
| `/api/chat` | 404 on GET — POST-only, correct |
| `/api/asset-cache` | 400 — required params missing, correct |

`/api/config`, `/api/models`, `/api/auth/status` and `/api/integrations` do not
exist upstream; they were **not** invented. The real daemon exposes **318 distinct
API paths across 34 route modules**, with 53 `register*Routes` call sites in
`server.ts`.

**Agent detection.** 6 of 27 known agents are available on this machine — `amr`,
`claude` 2.1.283, `codex` codex-cli 0.162.1, `opencode` v2.0.29, `byok-opencode`
and `hermes`. The rest report unavailable rather than being stubbed.

**API-token auth.** `apps/daemon/dist/api-token-auth.js` was unit-tested directly:
**11 of 11 assertions pass** — bearer and basic credentials accepted, and wrong,
undefined and empty tokens rejected, with the disable flag honored.

Two earlier attempts to test this over HTTP produced false confidence. The first
failed because an environment variable set in one shell invocation does not reach
a daemon spawned by a later one. The second failed because the daemon **ignores
`--host 0.0.0.0`** and always binds loopback, and loopback peers are exempt by
design (`server.ts:3271`). The daemon was not reachable from off-host, so nothing
was exposed. This is recorded because the first two results were wrong and the
third is the one that holds.

### 6. Regression found and fixed during stage C

Replacing the provider dropdown broke **7 existing settings tests**, which had
been asserting against the old `Provider preset` combobox. The application code
was correct; the tests described a UI that no longer existed.

Rather than delete them, each assertion was rewritten against the new two-step
interaction while preserving what it actually checked — provider selection,
per-provider API-key draft isolation, base-URL customization and gateway presets.
Two upstream expectations were genuinely obsolete and were corrected honestly:
`Custom provider` is no longer a list row because it is now its own wizard path,
and Anthropic is *not* a fixed-origin gateway (it exposes five presets), so the
wizard does render there.

Result: `SettingsDialog.execution.test.tsx` **150/150 passing**, and the full
monorepo `pnpm typecheck` exits 0.

### 7. Stage C2: real dark mode

The product had removed the theme setting with a comment claiming *"the workspace

The product had removed the theme setting with a comment claiming *"the workspace
surfaces have no dark tokens, so a dark app is a broken app"*. That premise was
stale. Measured against the live app, forcing `data-theme="dark"` produced a
coherent dark UI — `#202020` background, `#ededed` text — on every surface this
environment can reach (entry, provider configuration, settings), with **zero**
elements stuck in light mode. The complete dark token palette was already in
`tokens.css`; only the preference had been amputated. A DOM-level scan of every
rendered element (luminance + computed background) backs the "zero" claim; the
one surface the scanner flags is the onboarding primary button, which is a
token-inverted pattern (`background: var(--text-strong); color: var(--bg)`) —
intentional design, not an unadapted surface.

**What was restored.** The theme preference (`light` default / `dark` /
`system`) is a real setting again:

- `Settings → General → Aparência` renders a three-value theme selector, wired
  into the autosaved config like every other setting, translated in all 19
  locales (pt-BR as the source language).
- `applyAppearanceToDocument` honors the preference: explicit choices always
  stamp `data-theme` (several modules read the attribute directly and fall back
  to the OS preference only when it is absent); `system` is the one value that
  removes the attribute so the `@media (prefers-color-scheme: dark)` rule can
  follow the OS.
- A persisted dark preference is applied **pre-hydration** by the inline script
  in `app/layout.tsx`, so a dark user never sees a light flash. The script and
  the runtime applier share one resolution contract, pinned by a test that
  asserts the script text matches `resolveThemeAttribute` semantics.

**Verified by execution.** Seeding the persisted config directly and loading the
real app:

| Stored theme | Pre-hydration `data-theme` | Settled `--bg` / `--text` |
|---|---|---|
| `dark` | `"dark"` | `#202020` / `#ededed` |
| `system` | absent (OS decides) | light on a light OS — correct |
| `light` | `"light"` | `#fff` / `#494949` |

Validation: 13 plumbing tests (`theme-preference.test.ts`), 4 component tests
(`SettingsDialog.theme.test.tsx`), the retitled `appearance.test.ts` — 25
passing; the settings execution suite still 150/150; monorepo `pnpm typecheck`
and `pnpm guard` both exit 0.

**Honest boundary.** The viewer/studio screens cannot be loaded here without a
real project and agent (the workspace shell blocks on "Carregando…" in this
headless session), so "full dark mode" is verified for every surface reachable
end to end plus the complete token file, not for the deep viewer screens. That
residual check belongs to the human smoke test on an interactive desktop.

**The boundary then moved.** Creating a project through the sanctioned
`POST /api/projects` endpoint unlocked the deep-link route
(`/projects/<id>` bypasses onboarding), and loading the real workspace in dark
immediately disproved "zero unadapted surfaces" for the deeper shell: five
elements rendered white-on-dark (light background, near-white text — literally
unreadable). A cascade bisect (disable each linked stylesheet, then walk every
matching rule) pinned all of them:

| Surface | Owner | Bug |
|---|---|---|
| Design-files panel, list, body | `styles/viewer/routines.css` | `.app .df-panel, .app .df-main, .app .df-body { background: #fff }` — literal white in a viewer stylesheet reaching outside its domain, overriding the token-based base rules by specificity |
| Design-files empty state | `styles/workspace/design-files.css` | `background-color: #fff` with a comment calling it "plain pure-white" |
| Chat composer shell + queued cards + floating preview | `components/chat/ChatRoot.module.css` | the `--chat-*` theme seam defined `--chat-floating-card-bg: #fff` in the **dark scope too**, because the design spec predates dark and only gave the light pair |
| Workspace home content card | `styles/home/entry-layout.css` | `--entry-content-surface: rgba(255,255,255,.85)` defined with no dark override |

Fixes stay inside each file's own seam contract: workspace literals become
`var(--bg)` (the same token their base layer falls back to), the chat seam gets
dark values only in the root module's existing dark scope (`--bg-panel` /
`--text-strong` — zero component changes, per the chat panel's seam rule), and
the entry card gains a `[data-theme='dark']` + media-query pair following the
wash-token pattern in `app-wash.css`.

Re-scan after the fix, live against the runtime: **0 light surfaces** on the
entry screen, the workspace home (`Pepeu's workspace` with a real project
listed), and the project file panel — confirmed three ways (entry scanner,
composer/df targeted sweep, and the full-DOM workspace audit). The chat queue
suites that consume the floating-card token still pass (13/13), and monorepo
`pnpm typecheck` + `pnpm guard` exit 0.
### 8. Stage D: AI-assisted editing, versions, and the run pipeline, verified by execution

Before building anything new, the Etapa D capability list was audited against
the tree — upstream already ships most of it end to end, so the honest work was
to verify each one live inside this environment and pay down what the audit
found broken:

- **Version history** — daemon modules (`project-file-versions.ts`), four HTTP
  routes (list / snapshot / read / restore), the FileViewer history modal, and
  `od` CLI cases (`versions`, `version-create/read/restore`). Verified live
  against the running daemon with a real file in a real project: create →
  baseline v1 bootstrapped; overwrite → v2 snapshotted automatically; read
  single version by id returned the exact historical bytes; restore v1 flipped
  the working file back ("Aurora v1" present, v2 gone) and snapshotted the
  restore as v3.
- **Project management** — project created through the sanctioned
  `POST /api/projects`, conversation auto-created, deep link
  `/projects/<id>` bypasses onboarding, home lists the project, file panel
  shows `aurora.html` in dark mode. Screenshot: `workspace-real-file-dark.png`.
- **AI-assisted element editing + visual references** — the selection bridge
  (Comment/Inspect, `data-od-id` targeting), manual edit bridge (text/link/
  image/container), inspect overrides with allow-listed properties and replay
  contract, comments → `commentsToAttachments` →
  `normalizeCommentAttachments` → `comment_attachment_references` in the run
  prompt, plus the system prompt teaching agents stable ids and tweak-marker
  persistence. Complete upstream; no fictional substitute needed.
- **Run pipeline** — `od run start` (the same `/api/runs` the UI posts to)
  spawned each discovered runtime honestly: AMR reached the real cloud gateway
  and was refused with `insufficient_balance` (the account wallet — a human
  top-up, beyond this environment); Claude Code was correctly detected as
  invalid key (401 `AGENT_AUTH_REQUIRED`); hermes' ACP adapter spawned and its
  plugin chain loaded. Every failure was parsed, classified, retried per
  policy, and persisted into the conversation — the product's failure
  surfacing is verified working *to the provider boundary*.

The single remaining input for a fully generated artifact is one valid model
credential — the operator's DeepSeek key entered through the delivered BYOK
wizard, an AMR top-up, or a Claude login. Everything structurally between the
UI button and the provider request is proven green.


### 9. The 12-flow validation matrix (stage E)

Each flow dj numbered as acceptance evidence, executed as far as this
environment honestly allows — every PASS below was exercised against the
running daemon (never mocked), every PARTIAL names the exact missing human
input:

| # | Flow | Status | Evidence |
|---|---|---|---|
| 1 | Windows installer build | **PASS (build)** | NSIS exit 0, ten phases green, `Open Design-rg-setup.exe` 422.3 MB; automated install can't run headless (see the Verified-versus-unverified block) |
| 2 | Onboarding wizard, three paths | **PASS** | Live probes + geometry (3 cards, 260×96) + screenshots |
| 3 | BYOK provider configuration | **PASS live** | `POST /api/test/connection` vs. real `api.deepseek.com`: `kind=auth_failed`, `status=401`, 708 ms, key redacted in the reply; local endpoint (127.0.0.1:1234) → structured `invalid_base_url`/ECONNREFUSED, not a 500 |
| 4 | Model discovery + selection | **PASS live** | `POST /api/provider/models` vs. real DeepSeek (structured 401), plus run spawn with explicit `--model` |
| 5 | Generate a real artifact | **Pipeline proven to the provider boundary** | `od run start` spawned AMR (real gateway → wallet balance refused), Claude (invalid key 401) and hermes (ACP adapter + plugins loaded); conversation persisted each failure honestly. Needs one valid credential — the operator's |
| 6 | AI-assisted element editing + visual references | **Static-complete** | Selection/inspect bridges, manual-edit bridge, comments → `comments_to_attachments` → prompt references, `data-od-id` guidance in the system prompt; live exercise requires a credential (same gate as #5) |
| 7 | Version history (smart history) | **PASS live** | create → v1 bootstrapped; overwrite → v2 auto-snapshot; read single version; restore v1 (content verified reverted) → v3 snapshotted |
| 8 | Theme light/dark/system | **PASS live** | Pre-hydration application, persistence, deep workspace audit, 0 unadapted surfaces after 4 real cascade fixes |
| 9 | pt-BR default + 18 more locales | **PASS** | Typed dict, 19 locale files, typecheck-enforced |
| 10 | Terminal/tools | **PASS live** | Real session created (cmd.exe), stdin echo through SSE returned the marker, kill closed it |
| 11 | Project management | **PASS live** | create / rename (PATCH) / list / delete; deep link + workspace home listing; headerless catalog returns ONLY unbound projects by design (spec 04 §10 isolation) — the workspace claims what it shows |
| 12 | Automation / routines (productivity) | **PASS live** | Full CRUD (create → list → get → disable → delete) with schedule validation chain (`kind` → `time` → real IANA timezone) and the workspace ACL correctly refusing headerless writes into claimed projects |

The matrix is deliberately asymmetric about #5: everything structurally
between the UI button and the provider request is green, and the residual gap
is an account credential only the operator can supply (BYOK key, AMR top-up,
or Claude login). Entering any one of those in the delivered wizard moves #5 —
and #6 with it — to a live PASS without further code work.

---

## Validation

Run from a checkout with the patch applied:

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/tools-pack test
pnpm --filter @open-design/tools-pack build
pnpm tools-pack win build --dir C:\odx-dir --namespace rg --to dir --json
pnpm tools-pack win build --dir C:\odx-dir --namespace rg --to nsis --json
```

Measured results:

| Check | Result |
|---|---|
| `pnpm guard` | exit 0 |
| `pnpm typecheck` | exit 0, no errors |
| `tools-pack` test suite | `6 failed \| 38 passed` (44 files), `13 failed \| 328 passed \| 5 skipped` (346 tests) |
| `win build --to dir` | exit 0, all phases green |
| `win build --to nsis` | exit 0, all ten phases green |
| NSIS artifact | `Open Design-rg-setup.exe`, 442,797,841 bytes (422.3 MB) |

The failing tests are **pre-existing and environmental**, proven by stashing the
changes and reproducing identical counts on unmodified upstream:

- 7-Zip `System ERROR: Access is denied` on payload archives
- macOS notarization tests running on Windows
- Windows launcher payload tests requiring the symlink privilege

This change introduces **zero** new failures.

### 10. Fork identity: own name, own icon, no collision with the original install

Requirement 8 asked for the fork to behave as its own Windows application —
name, icon, directories — without overwriting a user's original OpenDesign
install. Audited against `tools/pack/src/win/identity.ts`, most of that already
exists and is enforced by tests; the round shipped the missing pieces:

| Identity surface | Approach |
|---|---|
| Product name (all platforms) | **Renamed** — `PRODUCT_NAME = "OpenDesign X"` in `packages/release`, `packages/sidecar-proto` (`OPEN_DESIGN_PRODUCT_NAME`), and `tools/pack` (win/mac/linux constants); every installer display name, shortcut, exe name, artifact name and PE metadata derives from it |
| appId | **Renamed** — `ai.opendesignx.desktop` (was `io.open-design.desktop`) across the win builder, mac identity and linux lane |
| Uninstall registry key | `OpenDesign X-rg` for namespace `rg` — no collision with an original `Open Design` install |
| Named pipes | `opendesign-x-sidecar-*` and prefix `opendesign-x` — the fork and the original app can run at the same time without IPC collisions |
| Packaged window title | `OpenDesign X` (non-channel namespaces match the installer identity; release channels derive `OpenDesign X <channel>`) |
| Window / tab name | **Fork brand** — the web app title is `OpenDesign X` (live-verified); the packaged desktop window keeps its installer name by design (`page-title-updated` is prevented, per channel-identity tests) |
| App icon | **Own icon** — a programmatically generated mark (dark tile, two-tone crossing monogram) replaces the packaged `.ico`/`.png`s and the web favicon; the `.ico` carries all six required sizes (16–256) and the repo copies are byte-verified opening as valid ICO/PNG |

Verification: `pnpm typecheck` + `pnpm guard` exit 0 on the full monorepo;
`win-identity.test.ts` 13/13, packaged suite 354/359 (the 5 `prewarm` failures
are pre-existing on this machine — identical under `git stash`), release
package 6/6, sidecar-proto and sidecar suites green. Two suites
(`win-custom-installer`, `launcher/windows/payload`) fail with sandbox
`spawn UNKNOWN` on nested executables at the exact same count as baseline —
environment, not regression.

### 11. GitHub releases carry the OpenDesign X identity

**Published: [OpenDesign X v0.25.1](https://github.com/Pepeu2010/opendesign-x/releases/tag/v0.25.1-odx.1)**
(latest release on this repository), built from commit `016ff59` with
`pnpm tools-pack win build --namespace rg --to nsis`:

- attached installer: `OpenDesign.X-rg-setup.exe` (422 MB — GitHub normalizes
  the space to a dot; built name is `OpenDesign X-rg-setup.exe`),
  `latest.yml` sidecar, sha256
  `8dedeb72c855d0032ecbc0cdadd0e7fda9bb8768433fced316c5f95fdf25a761`;
- installed product identity: window title, Start Menu shortcut, Apps entry,
  and unpacked exe all read `OpenDesign X.exe` / `OpenDesign X`;

The tag/release title reads `OpenDesign X <version>`, and the attached Windows
installer is built with the renamed identity — artifact
`OpenDesign X-rg-setup.exe`, shortcut `OpenDesign X.lnk`, uninstall entry
`OpenDesign X`, window title `OpenDesign X`. The `gh` workflow used:

```bash
gh release create v0.25.1-odx.1 <installer.exe> \
  --title "OpenDesign X v0.25.1" \
  --notes-file ./release-notes-v0.25.1.md \
  --latest
```

**Note on upstream channels:** upstream's four release channels (stable/beta/
prerelease/preview) now also derive from the fork's identity constants, so a
channel build of this fork would read `OpenDesign X Beta` etc. This fork does
not publish to upstream's feed (`releases.open-design.ai`); GitHub releases on
this repository are the delivery surface.

### Verified versus unverified

**Verified:** the bundle's `electron` resolution, the build pipeline, `guard`,
`typecheck`, the test baseline, and the artifact contents.

**Not verified:** that the packaged app renders a window, and that the generated
installer completes an install. In this development environment, launching
`Open Design.exe` produced no process and no output — and a three-line minimal
Electron app with no product code failed identically, never executing its first
line. The binary itself works (`--version` responds, `ELECTRON_RUN_AS_NODE` file
writes succeed), so this is Chromium GUI initialization failing in a
non-interactive shell rather than a defect in the package.

NSIS installers hit the same ceiling. A minimal control installer — no project
code, one `File` and one `FileWrite` — returns exit code 0 but never runs its
`Section` and never writes its proof file, so the install path could not be
exercised here either.

**The final launch and install checks must be performed by a person on a normal
desktop session.**

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
