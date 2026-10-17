import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { createPackagedRequire } from "../src/create-packaged-require.js";

const helperSource = readFileSync(
  new URL("../src/create-packaged-require.ts", import.meta.url),
  "utf8",
);

describe("createPackagedRequire", () => {
  test("resolves workspace packages from the ESM context via import.meta.url", () => {
    const require = createPackagedRequire(import.meta);
    // The packaged main resolves internal workspace packages (sidecars.ts)
    // and `next/package.json` under the web root (prewarm.ts) — a require
    // anchored on the calling file must do both from node_modules walks.
    const resolved = require.resolve("../package.json");
    expect(resolved).toContain("apps");
    expect(resolved).toContain("package.json");
  });

  test("keeps the CJS-bundle fallback contract: __filename first, meta.url second", () => {
    // In the prebundled packaged-main (esbuild CJS output) `import.meta` is
    // an empty object, so `import.meta.url` is undefined — the previous
    // `createRequire(import.meta.url)` died with ERR_INVALID_ARG_VALUE at
    // module init and the packaged app showed "could not start". The helper
    // must prefer `__filename` (present in the CJS bundle) and only fall
    // back to the meta URL for ESM source contexts.
    expect(helperSource).toContain('typeof __filename === "string"');
    expect(helperSource).toContain("pathToFileURL(meta.url).href");
    expect(helperSource).not.toContain("createRequire(meta.url)");
  });
});
