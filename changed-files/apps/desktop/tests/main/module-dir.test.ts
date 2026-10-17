import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { desktopMainModuleDir } from "../../src/main/module-dir.js";

const readDesktopSource = (name: string): string =>
  readFileSync(new URL(`../../src/main/${name}`, import.meta.url), "utf8");

/**
 * Regression coverage for the packaged "process alive, no window" failure. The
 * packaged desktop main is prebundled to CommonJS, where esbuild replaces
 * `import.meta` with an empty object: `fileURLToPath(import.meta.url)` threw
 * `ERR_INVALID_ARG_TYPE` inside `createDesktopRuntime`, the runtime exited with
 * code 1, and the daemon/web sidecars stayed alive with no window on screen.
 */
describe("desktopMainModuleDir", () => {
  test("answers with the desktop-main module directory", () => {
    // Every desktop main module is compiled into the same directory
    // (`src/main` in vitest, `dist/main` when built, the prebundled file when
    // packaged), so the helper's own directory is the answer callers need.
    const helperDir = dirname(fileURLToPath(new URL("../../src/main/module-dir.ts", import.meta.url)));
    expect(desktopMainModuleDir(import.meta)).toBe(helperDir);
  });

  test("every bundled desktop module resolves paths through the helper, never a bare import.meta.url", () => {
    for (const name of ["runtime.ts", "index.ts", "deck-capture.ts"]) {
      const source = readDesktopSource(name);
      expect(source, `${name} must not read import.meta.url directly`).not.toContain(
        "fileURLToPath(import.meta.url)",
      );
      expect(source, `${name} must use the helper`).toContain("desktopMainModuleDir(import.meta)");
    }
  });

  test("keeps the CommonJS bundle contract: __filename first, module URL second", () => {
    const source = readFileSync(new URL("../../src/main/module-dir.ts", import.meta.url), "utf8");
    expect(source).toContain('typeof __filename === "string"');
    expect(source).toContain("fileURLToPath(meta.url)");
  });
});
