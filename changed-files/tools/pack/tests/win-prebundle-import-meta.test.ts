import { describe, expect, test } from "vitest";

import { findWinPrebundleImportMetaDereferences } from "@/win/prebundle.js";

/**
 * Regression coverage for the packaged-desktop startup failure: esbuild cannot
 * express `import.meta` in CommonJS output, so it emits an empty object and any
 * property read on it is `undefined` at runtime. The desktop died while
 * assembling its window options ("The \"path\" argument must be of type string
 * ... Received undefined"), exited with code 1, and left the daemon and web
 * sidecars running with no window on screen. The prebundle step must reject
 * such a bundle while still allowing the guarded `__filename` helpers.
 */
describe("findWinPrebundleImportMetaDereferences", () => {
  test("flags the dereference that killed the packaged desktop", () => {
    const bundle = [
      "var import_meta4 = {};",
      "require2 = (0, import_node_module.createRequire)(import_meta4.url);",
    ].join("\n");

    expect(findWinPrebundleImportMetaDereferences(bundle)).toEqual(["import_meta4.url"]);
  });

  test("flags the unnumbered and higher-numbered forms", () => {
    const bundle = "const a = import_meta.url;\nconst b = import_meta12.dirname;";

    expect(findWinPrebundleImportMetaDereferences(bundle)).toEqual([
      "import_meta.url",
      "import_meta12.dirname",
    ]);
  });

  test("allows passing the empty object into a __filename-first helper", () => {
    const bundle = [
      "var import_meta5 = {};",
      "require2 = (0, create_packaged_require.createPackagedRequire)(import_meta5);",
      "const dir = (0, module_dir.desktopMainModuleDir)(import_meta5);",
    ].join("\n");

    expect(findWinPrebundleImportMetaDereferences(bundle)).toEqual([]);
  });

  test("passes a bundle that resolves paths from __filename", () => {
    const bundle = [
      'var moduleDir = typeof __filename === "string" ? path.dirname(__filename) : fallback;',
    ].join("\n");

    expect(findWinPrebundleImportMetaDereferences(bundle)).toEqual([]);
  });

  test("does not flag unrelated identifiers that merely contain the word", () => {
    expect(findWinPrebundleImportMetaDereferences("const my_import_metadata = 1;")).toEqual([]);
  });
});
