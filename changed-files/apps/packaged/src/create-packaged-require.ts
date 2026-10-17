import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * `createRequire(import.meta.url)` breaks inside the prebundled packaged
 * main: esbuild's CJS output replaces `import.meta` with an empty object
 * (no `.url`), so the base argument arrives as `undefined` and the module
 * dies at init time — before any sidecar starts. Anchor the require on the
 * bundled file itself instead: CJS bundles carry `__filename`, ESM source
 * (unit tests, tsx runs) carries `import.meta.url`. Both point into the same
 * tree, so node_modules resolution is identical in every context.
 */
export function createPackagedRequire(meta: ImportMeta): NodeRequire {
  const base =
    typeof __filename === "string"
      ? __filename
      : pathToFileURL(meta.url).href;
  return createRequire(base);
}
