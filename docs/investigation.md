# Stage log

Chronological record of what was investigated, what was proven, and what remains
open. Entries record measurements, not intentions.

---

## Stage A — real installable Windows application

### Investigation

Upstream ships `apps/packaged` as the thin packaged Electron runtime entry, built
by `tools/pack` through four control planes (`tools-dev`, `tools-pack`,
`tools-serve`, `tools-release`). The Windows lane is
`pnpm tools-pack win build --to <all|dir|nsis|zip>`.

`--to dir` produces `win-unpacked` and skips NSIS entirely.

### Blocker 1 — NSIS cannot create macOS symlinks

electron-builder's Go `app-builder` extracts `winCodeSign-2.6.0.7z` from its cache.
That archive contains two macOS symlinks:

```
darwin/10.12/lib/libcrypto.dylib
darwin/10.12/lib/libssl.dylib
```

Extraction runs:

```
7za.exe x -snld -bd '<cache>\winCodeSign\<hash>.7z' '-o<cache>\winCodeSign\<hash>'
```

On a machine without `SeCreateSymbolicLinkPrivilege` this fails:

```
ERROR: Cannot create symbolic link : O cliente não tem o privilégio necessário.
Sub items Errors: 2
```

Attempts and outcomes:

| Attempt | Outcome |
|---|---|
| Pre-create `.complete` marker | Failed — the hash changes per run |
| `toolsets: { winCodeSign: "1.0.0" }` | Failed — still fetched 2.6.0 |
| Seed a completed kit minus `darwin` | Partial — kit resolves, extraction still runs |
| Mirror a **repacked** symlink-free archive | Failed — `sha512 checksum mismatch` |
| Mirror the **pristine** archive | Checksum passes, symlink error returns |
| 7-Zip 25.01 | Failed identically |
| Pre-existing target directory | 7za still attempts the symlink |

**Conclusion.** electron-builder verifies the archive sha512, so the archive must be
byte-identical. The privilege itself is therefore still required. Windows Developer
Mode grants it at logon, so sign-out/sign-in is unavoidable.

Working path: **`--to dir`**, which bypasses NSIS and builds green (exit 0).

### Blocker 2 — packaged app died at startup

Both `Open Design.exe` and `Open Design.exe resources\app` exited silently.
`tools-pack win inspect` showed sidecar pipes never binding:

```
connect ENOENT \\.\pipe\open-design-sidecar-<hash>
```

Running with `ELECTRON_RUN_AS_NODE=1` surfaced the underlying error:

```
packaged entry failed .../prebundled/packaged-main.mjs:2445
import { BrowserWindow, dialog } from "electron";
SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'
```

followed by the app's own handler:

```
Open Design could not start. Download and reinstall the latest Open Design
installer for the same release channel. Keep your application data.
```

**Cause.** `WIN_PREBUNDLE_POLICIES.packagedMain.externals` deliberately lists
`electron`, and the esbuild invocation used `--format=esm`. ESM bundles of a module
that imports Electron bindings by name therefore emit native ESM named imports,
which Electron's ESM loader cannot satisfy against its CommonJS `electron` module.

This is latent upstream behavior: `apps/packaged/src/index.ts` has imported
`{ app, dialog } from "electron"` since 2026-10-08, and no test asserted the
bundle's `electron` import shape.

**Rejected fixes.**

- `--alias:electron=<shim>` where the shim does `require("electron")` — the alias
  rewrote the shim's own specifier, producing
  `module.exports = require_electron_shim()` and infinite recursion.
- Adding `--external:electron` alongside the alias — external lost to the alias.
- A shim using `createRequire(__filename)("electron")` — Node's CJS resolver does
  not know Electron's built-in module:
  `Error: Cannot find module 'electron'`.

**Applied fix.** Emit the packaged main as CommonJS:

```diff
-    "--format=esm",
+    "--format=cjs",
```

with the artifact renamed `packaged-main.mjs` → `packaged-main.cjs`, and the entry
renderer parameterized per platform so macOS keeps its ESM prebundle.

**Verified in the shipped artifact.** `packaged-main.cjs` contains
`import_electron = require("electron")` and **no** `import { ... } from "electron"`.

### Regression caught during implementation

The first attempt changed the shared `renderPackagedMainEntry` default, which
silently changed **macOS** behavior and broke
`tests/prebundle/macos.test.ts`. Fixed by passing the macOS path explicitly.

The shared entry test then wrote a CommonJS fixture body into a `.mjs` file, which
fails because `exports` is undefined in an ES module. Fixed by deriving both the
filename and the module system from the renderer under test.

### Environment limitation

Launching any real Electron GUI app in this environment produces no process and no
output. A three-line minimal Electron app failed identically, never executing its
first line:

```
main.cjs NEVER RAN
```

Yet the same binary works in Node mode:

```
Open Design.exe --version            -> v24.15.0
ELECTRON_RUN_AS_NODE=1 <write probe> -> ELECTRON-NODE-WROTE
```

So the binary, the bundle, and file writes all function; Chromium GUI
initialization fails in a non-interactive shell. **The final window check requires a
human on a normal desktop session.**

### Stage A result

| Item | Result |
|---|---|
| `--to dir` build | exit 0, all phases green |
| `packaged-main.cjs` | present, `require("electron")` |
| ESM named import of electron | eliminated |
| `pnpm guard` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `tools-pack` tests | identical to stashed baseline |
| NSIS installer | blocked on sign-out/sign-in |
| App window | unverified — environment cannot run GUI Electron |

---

## Provider catalog additions

Added three OpenAI-compatible providers to `apps/web/src/state/config.ts`:

- **Groq** — `https://api.groq.com/openai/v1`
- **Fireworks AI** — `https://api.fireworks.ai/inference/v1`
- **LM Studio (local)** — `http://127.0.0.1:1234/v1`, `requiresApiKey: false`

`BYOK_PROVIDER_PRESETS` resolves each preset by provider `label` and throws
`Missing known provider for BYOK preset: <label>` when absent, so the provider
entries and presets must stay in sync.

Verified live against a running dev daemon: the OpenAI protocol tab lists 26
providers including all three additions; the Anthropic tab lists 6; Google Gemini 2;
Ollama Cloud 3. Provider options are filtered by the selected protocol.
