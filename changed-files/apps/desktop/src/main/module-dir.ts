import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory of the calling desktop-main module in every runtime context.
 *
 * The packaged desktop main is prebundled to CommonJS (see `tools/pack` win
 * prebundle). esbuild cannot express `import.meta` in that format — it emits an
 * empty object — so `fileURLToPath(import.meta.url)` throws
 * `ERR_INVALID_ARG_TYPE` and the packaged runtime died while assembling its
 * window options, before any window appeared.
 *
 * `__filename` is a real CommonJS global inside that bundle and points at the
 * same tree, so it is the primary source. ESM source (unit tests, tsx dev runs)
 * has no `__filename`; there the module URL remains the only answer.
 */
export function desktopMainModuleDir(meta: ImportMeta): string {
  const moduleFile = typeof __filename === "string" ? __filename : fileURLToPath(meta.url);
  return dirname(moduleFile);
}