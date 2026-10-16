# Test plan

Twelve user flows that must be executed against a real build before this project is
called done. No flow is recorded as passing without an executed run.

Status values: **Pass**, **Fail**, **Blocked** (with the blocking condition), or
**Not run**. "Verified by inspection" is not a status.

---

## Acceptance criterion

> Open the application, enter a DeepSeek key or a compatible endpoint, select a
> model, and generate a real artifact.

Flow 1 through Flow 5 cover this directly.

---

## Flows

### 1. Launch

Open the installed application from the Start Menu shortcut.

- A window appears within a reasonable time
- No error dialog
- The daemon and web sidecars reach a healthy state
- Assert: `/api/health` returns `{"ok":true,...}`

**Status:** Not run — blocked on a GUI-capable session.

### 2. First-run onboarding

A first launch on a clean profile reaches onboarding, not a broken shell.

- Onboarding renders
- Language defaults to pt-BR, with English selectable
- No console errors

**Status:** Not run.

### 3. Add a provider key

Enter a DeepSeek API key through the model/provider entry point.

- The key is accepted
- The key is stored securely, not in plain text in the project
- A connection test succeeds
- The key is never written to logs or echoed back

**Status:** Not run.

### 4. Discover and select a model

After adding a provider, list its models and select one.

- Model discovery returns real models for the provider
- The selected model persists per project
- An invalid key produces a clear error, not a silent failure

**Status:** Not run.

### 5. Generate a real artifact

With a model selected, run a generation end to end.

- A real artifact is produced
- The artifact opens in the viewer
- It can be exported

**Status:** Not run — this is the acceptance criterion.

### 6. Local model endpoint

Point the app at a local OpenAI-compatible endpoint (Ollama, LM Studio, vLLM).

- The endpoint is accepted without an API key where appropriate
- Models are discovered from the local server
- Generation works against it

**Status:** Not run.

### 7. Custom provider

Add a provider that is not in the built-in catalog.

- A custom base URL and protocol are accepted
- Models are discovered
- The provider persists across restarts

**Status:** Not run.

### 8. Project lifecycle

Create, open, switch, and delete projects.

- Projects persist across restarts
- Switching projects preserves per-project model selection
- Deletion does not orphan data

**Status:** Not run.

### 9. Existing feature preservation

Confirm upstream capabilities still work after the modifications.

- Chat and run execution
- Agent CLI detection
- Skills and design systems
- Artifact viewing and export

**Status:** Not run.

### 10. Theme

Toggle dark and light modes.

- Both themes render across shell, chat, viewer, and home
- No unstyled or low-contrast regions
- The choice persists

**Status:** Not run.

### 11. Installer and upgrade

Install via the NSIS installer, then reinstall over an existing installation.

- Start Menu shortcut is created
- The application icon is correct
- Application data survives the reinstall
- A pre-existing installation of the original Open Design is **not** modified

**Status:** Blocked — NSIS build requires `SeCreateSymbolicLinkPrivilege`, granted
at logon. Developer Mode is enabled; a sign-out/sign-in is required.

### 12. Failure handling

Confirm the app degrades honestly.

- Invalid key produces a readable error
- Unreachable endpoint produces a readable error
- A failed generation does not corrupt project state
- No simulated or placeholder output is ever shown as if it were real

**Status:** Not run.

---

## Recorded evidence

| Flow | Environment | Result | Evidence |
|---|---|---|---|
| 1 | Windows, unpacked build | Blocked | Process exits before user code; minimal Electron app fails identically |
| 5 | Dev runtime (daemon + web) | Partial | Dev runtime verified only; packaged generation not yet run |

Nothing else has been executed yet. This table gets a row per executed flow,
including failures.
