import { assertPackagedSidecarRuntime } from "../resources/runtime-manifest.js";
import { execFile } from "node:child_process";
import { createReadStream, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";


import { hashJson, hashPath, type CacheNode, ToolPackCache } from "../cache/index.js";
import type { ToolPackConfig } from "../config/index.js";
import { domToPptxBundleResource } from "../dom-to-pptx-resource.js";
import {
  assertNodePtyRuntime,
  validateNodePtyRuntime,
} from "../node-pty-runtime.js";
import { winResources } from "../resources/index.js";
import { electronBuilderVersionForAppVersion, versionCoreForAppVersion } from "../versioning/index.js";
import {
  WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
  shouldUseWinStandalonePrebundle,
} from "./prebundle.js";
import {
  buildCustomWinNsisInstaller,
  hashWinNsisBasePayloadInputs,
  buildWinNsisBasePayload,
  buildWinNsisOverlayPayload,
  resolveWinNsisOverlayRequiredPaths,
} from "./custom-installer.js";
import {
  ELECTRON_BUILDER_ASAR,
  ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
  ELECTRON_BUILDER_FILE_PATTERNS,
  ELECTRON_BUILDER_NODE_GYP_REBUILD,
  ELECTRON_BUILDER_NPM_REBUILD,
  NSIS_INSTALLER_LANGUAGE_BY_WEB_LOCALE,
  PRODUCT_NAME,
  WEB_STANDALONE_HOOK_CONFIG_ENV,
  WEB_STANDALONE_RESOURCE_NAME,
} from "./constants.js";
import { pathExists, removeTree } from "./fs.js";
import {
  readPackagedVersion,
  writeBuiltAppManifest,
  writePackagedConfig,
} from "./manifest.js";
import { ensureNsisPersianLanguageAlias, writeNsisInclude } from "./nsis.js";
import { resolveWinArtifactNamespaceSuffix, sanitizeNamespace } from "./paths.js";
import {
  resolveElectronBuilderWinTargets,
  shouldBuildWinNsisInstaller,
  shouldBuildWinPortableZip,
} from "./report.js";
import type { ResourceTreeResult } from "./resources.js";
import {
  resolveWinSigningCacheKey,
  signAndVerifyWinFile,
} from "./sign.js";
import {
  readWinExecutableVersionSnapshot,
  resolveWinExecutableVersionTargets,
  rewriteWinExecutableVersion,
} from "./version-resource.js";
import { buildWinPortableZip } from "./zip.js";
import type {
  ElectronBuilderDirCacheMetadata,
  WinBuiltAppManifest,
  WinPackTiming,
  WinPaths,
} from "./types.js";

const execFileAsync = promisify(execFile);
const WIN_ARCHIVE_CACHE_VERSION = 3;
const WIN_ELECTRON_BUILDER_DIR_CACHE_VERSION = 9;
const WIN_NSIS_BASE_PAYLOAD_INPUT_HASH_CACHE_VERSION = 2;

async function hashWinNsisInstallerImplementation(config: ToolPackConfig): Promise<string> {
  const sourceModulePath = join(config.workspaceRoot, "tools", "pack", "src", "win", "custom-installer.ts");
  if (await pathExists(sourceModulePath)) return hashPath(sourceModulePath);
  const currentModulePath = fileURLToPath(import.meta.url);
  return hashPath(currentModulePath);
}

function logWinBuildProgress(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`[tools-pack win] ${message}${suffix.length === 0 ? "" : ` ${suffix}`}\n`);
}

async function assertWebStandaloneOutput(config: ToolPackConfig): Promise<void> {
  const webRoot = join(config.workspaceRoot, "apps", "web");
  const standaloneSourceRoot = join(webRoot, ".next", "standalone");
  const candidates = [
    join(standaloneSourceRoot, "apps", "web", "server.js"),
    join(standaloneSourceRoot, "server.js"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return;
  }

  throw new Error("Next.js standalone server output was not produced under apps/web/.next/standalone");
}

async function writeWebStandaloneHookConfig(
  config: ToolPackConfig,
  paths: WinPaths,
  hyperframesRuntimeSourceRoot: string,
): Promise<string> {
  const webRoot = join(config.workspaceRoot, "apps", "web");
  await assertWebStandaloneOutput(config);

  await mkdir(dirname(paths.webStandaloneHookConfigPath), { recursive: true });
  await writeFile(
    paths.webStandaloneHookConfigPath,
    `${JSON.stringify(
      {
        auditReportPath: paths.webStandaloneHookAuditPath,
        hyperframesRuntimeSourceRoot,
        pruneCopiedSharp: true,
        pruneRootNext: true,
        pruneRootSharp: true,
        requireRootWebPackageAudit: !shouldUseWinStandalonePrebundle(config.webOutputMode),
        resourceName: WEB_STANDALONE_RESOURCE_NAME,
        standaloneSourceRoot: join(webRoot, ".next", "standalone"),
        version: 1,
        webPublicSourceRoot: join(webRoot, "public"),
        webStaticSourceRoot: join(webRoot, ".next", "static"),
        workspaceRoot: config.workspaceRoot,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return paths.webStandaloneHookConfigPath;
}

/**
 * Point electron-builder's Windows kits lookup at a symlink-free extraction of
 * the winCodeSign bundle.
 *
 * Why this exists: electron-builder's legacy `getBin("winCodeSign")` path lets
 * its bundled `app-builder` extract `winCodeSign-2.6.0.7z`, which contains two
 * macOS `.dylib` entries stored as symlinks. `7za` extracts with `-snld`, and
 * creating a symlink needs SeCreateSymbolicLinkPrivilege — unavailable to an
 * unelevated Windows account and to any account without Developer Mode. The
 * whole build then aborts with "Cannot create symbolic link ... o cliente não
 * tem o privilégio necessário" before NSIS runs, even though a Windows build
 * only ever consumes `windows-10/**`, `appxAssets`, and `rcedit-*.exe`.
 *
 * `ELECTRON_BUILDER_WINDOWS_KITS_PATH` and `ELECTRON_BUILDER_OSSL_SIGNCODE_PATH`
 * are supported upstream override points that skip the download entirely. We
 * seed a kit once by copying a completed legacy extraction minus its `darwin`
 * tree; a cache whose extraction failed has no usable `windows-10` tree and is
 * treated as absent rather than trusted.
 *
 * The kits overrides alone are not enough: the compiled downloader still
 * fetches winCodeSign 2.6.0 for its own reasons and ignores the JavaScript-side
 * toolset config. `ELECTRON_BUILDER_BINARIES_MIRROR` is honoured by that
 * downloader, so it is pointed at a loopback server that serves a repacked
 * archive with no `darwin` tree — see `seedDarwinFreeWinCodeSignArchive`.
 */
function winCodeSignKitEnv(kitRoot: string): Record<string, string> {
  const configured = process.env.ELECTRON_BUILDER_WINDOWS_KITS_PATH;
  if (configured != null && configured.trim().length > 0) return {};

  return {
    ELECTRON_BUILDER_BINARIES_MIRROR: `http://127.0.0.1:${WIN_CODE_SIGN_MIRROR_PORT}/`,
    ELECTRON_BUILDER_OSSL_SIGNCODE_PATH: "osslsigncode",
    ELECTRON_BUILDER_RCEDIT_PATH: kitRoot,
    ELECTRON_BUILDER_WINDOWS_KITS_PATH: kitRoot,
  };
}

async function resolveSeededWinCodeSignKitAsync(): Promise<string | null> {
  const kitRoot = resolveSeededWinCodeSignKit();
  if (kitRoot == null) return null;
  await seedWinCodeSignMirrorArchive(kitRoot);
  return kitRoot;
}

function resolveSeededWinCodeSignKit(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData == null || localAppData.trim().length === 0) return null;

  const cacheRoot = join(localAppData, "electron-builder", "Cache", "winCodeSign");
  const kitRoot = join(cacheRoot, "odx-kit");
  if (hasWindowsKitTree(kitRoot)) return kitRoot;

  // Seed from any completed extraction in the cache. Extraction order is not
  // stable, so scan every candidate and take the first that carries a real
  // Windows kit tree.
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(cacheRoot, entry);
    if (!hasWindowsKitTree(candidate)) continue;
    try {
      cpSync(candidate, kitRoot, {
        filter: (source) => basename(source) !== "darwin",
        force: true,
        recursive: true,
      });
    } catch {
      continue;
    }
    return hasWindowsKitTree(kitRoot) ? kitRoot : null;
  }
  return null;
}

/**
 * Publish the genuine `winCodeSign-2.6.0.7z` on the mirror.
 *
 * The archive must be byte-identical to upstream: `app-builder` verifies its
 * sha512 before extracting, so a repacked archive is rejected outright
 * ("sha512 checksum mismatch"). Serving the pristine bytes is the only way the
 * download step can pass; it does not by itself solve the symlink problem,
 * which `ensureWinCodeSignExtraction` handles for the fixed path we point
 * `rcedit` and the Windows kits at.
 */
async function seedWinCodeSignMirrorArchive(kitRoot: string): Promise<void> {
  const mirrorDir = join(kitRoot, "mirror", WIN_CODE_SIGN_RELEASE_DIR);
  const archivePath = join(mirrorDir, WIN_CODE_SIGN_LEGACY_ARCHIVE);
  if (existsSync(archivePath)) return;

  const sourceArchive = findWinCodeSignArchive(dirname(kitRoot));
  if (sourceArchive == null) return;

  try {
    await mkdir(mirrorDir, { recursive: true });
    await cp(sourceArchive, archivePath);
  } catch {
    // A missing mirror only means the download falls back to upstream.
  }
}

function findWinCodeSignArchive(cacheRoot: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".7z")) continue;
    const candidate = join(cacheRoot, entry);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hasWindowsKitTree(root: string): boolean {
  return existsSync(join(root, "windows-10", "x64", "signtool.exe"))
    && existsSync(join(root, "rcedit-x64.exe"));
}

const WIN_CODE_SIGN_LEGACY_ARCHIVE = "winCodeSign-2.6.0.7z";
const WIN_CODE_SIGN_RELEASE_DIR = "winCodeSign-2.6.0";
const WIN_CODE_SIGN_MIRROR_PORT = 8791;

/**
 * Serve the seeded mirror over loopback HTTP for the duration of a build.
 *
 * The compiled `app-builder` downloader performs a real HTTP GET, so a
 * `file://` mirror is refused; the override must be an origin. The server binds
 * `127.0.0.1` only and serves the symlink-free archive staged by
 * `seedDarwinFreeWinCodeSignArchive`.
 */
async function startWinCodeSignMirror(kitRoot: string): Promise<(() => void) | null> {
  const mirrorRoot = join(kitRoot, "mirror");
  if (!existsSync(mirrorRoot)) return null;

  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const resolved = join(mirrorRoot, requestPath);
    // Refuse traversal out of the mirror root.
    if (!resolved.startsWith(mirrorRoot)) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": String(statSync(resolved).size) });
    createReadStream(resolved).pipe(response);
  });

  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(WIN_CODE_SIGN_MIRROR_PORT, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    // A server already bound on the port is assumed to be a previously started
    // mirror; leave it alone and let the build use it.
    return () => {};
  }
  return () => {
    server.close();
  };
}

async function runElectronBuilderRaw(
  config: ToolPackConfig,
  paths: WinPaths,
  projectDir: string,
): Promise<WinPackTiming[]> {
  const segments: WinPackTiming[] = [];
  const runSegment = async <T>(
    phase: string,
    task: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const startedAt = Date.now();
    logWinBuildProgress("segment:start", { phase });
    try {
      const result = await task();
      logWinBuildProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinBuildProgress("segment:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      throw error;
    } finally {
      segments.push({ details, durationMs: Date.now() - startedAt, phase });
    }
  };

  const namespaceToken = sanitizeNamespace(config.namespace);
  const releaseArtifactNamespaceSuffix = resolveWinArtifactNamespaceSuffix(config.namespace);
  const packagedVersion = await runSegment("electron-builder-raw:read-packaged-version", async () =>
    readPackagedVersion(config)
  );
  const packageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  const webStandaloneHookConfigPath = config.webOutputMode === "standalone"
    ? await runSegment("electron-builder-raw:write-web-standalone-hook-config", async () =>
      writeWebStandaloneHookConfig(config, paths, projectDir)
    )
    : null;
  const builderConfig = {
    appId: "ai.opendesignx.desktop",
    afterPack: webStandaloneHookConfigPath == null ? undefined : winResources.webStandaloneAfterPackHook,
    asar: ELECTRON_BUILDER_ASAR,
    buildDependenciesFromSource: ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
    compression: "maximum",
    directories: { output: paths.appBuilderOutputRoot },
    // Let electron-builder download the win32 Electron itself instead of
    // pointing at node_modules' dist. pnpm does not reliably materialize the
    // Electron dist on CI runners (electron.exe can be missing), which made
    // the rename to `${PRODUCT_NAME}.exe` fail with ENOENT. The mac builder
    // already relies on electron-builder's own download and is the only
    // platform that stayed green through this regression.
    electronVersion: config.electronVersion,
    executableName: PRODUCT_NAME,
    extraMetadata: {
      main: "./main.cjs",
      name: "open-design-packaged-app",
      productName: PRODUCT_NAME,
      version: packageVersion,
    },
    extraResources: [
      { from: paths.resourceRoot, to: "open-design" },
      { from: paths.packagedConfigPath, to: "open-design-config.json" },
      // Vendored dom-to-pptx browser bundle for editable PPTX export (read from
      // process.resourcesPath by the desktop main at runtime).
      domToPptxBundleResource(config),
    ],
    files: [...ELECTRON_BUILDER_FILE_PATTERNS],
    forceCodeSigning: false,
    icon: paths.winIconPath,
    nodeGypRebuild: ELECTRON_BUILDER_NODE_GYP_REBUILD,
    npmRebuild: ELECTRON_BUILDER_NPM_REBUILD,
    nsis: {
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      artifactName: `${PRODUCT_NAME}${releaseArtifactNamespaceSuffix}-setup.\${ext}`,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
      displayLanguageSelector: false,
      include: paths.nsisIncludePath,
      installerLanguages: Object.values(NSIS_INSTALLER_LANGUAGE_BY_WEB_LOCALE),
      language: "1033",
      multiLanguageInstaller: true,
      oneClick: false,
      perMachine: false,
      shortcutName: PRODUCT_NAME,
      warningsAsErrors: false,
    },
    productName: PRODUCT_NAME,
    publish: [{ provider: "generic", url: "https://updates.invalid/open-design" }],
    // Pin the versioned winCodeSign toolset instead of letting electron-builder
    // fall back to the legacy `getBin("winCodeSign")` bundle. The legacy
    // winCodeSign-2.6.0.7z contains macOS `.dylib` symlinks, and 7za extracts it
    // with `-snld`; creating a symlink requires SeCreateSymbolicLinkPrivilege,
    // which an unelevated Windows account does not hold. The extraction then
    // fails with "Cannot create symbolic link ... cliente não tem o privilégio
    // necessário" and aborts the whole build before NSIS ever runs, even though
    // only rcedit-x64.exe is actually needed on Windows. A versioned toolset
    // fetches `rcedit-windows-2_0_0.zip` — a plain zip with no symlinks — so the
    // unsigned Windows build works without elevation or Developer Mode.
    toolsets: { winCodeSign: "1.0.0" },
    win: {
      artifactName: `${PRODUCT_NAME}${releaseArtifactNamespaceSuffix}.\${ext}`,
      icon: paths.winIconPath,
      target: resolveElectronBuilderWinTargets(config.to).map((target) => ({ arch: ["x64"], target })),
    },
  };

  await runSegment("electron-builder-raw:prepare-config", async () => {
    await removeTree(paths.appBuilderOutputRoot);
    await mkdir(dirname(paths.appBuilderConfigPath), { recursive: true });
    await writeNsisInclude(config, paths);
    await writeFile(paths.appBuilderConfigPath, `${JSON.stringify(builderConfig, null, 2)}\n`, "utf8");
  });

  const build = async (phase: string) => {
    await runSegment(phase, async () => {
      const kitRoot = await resolveSeededWinCodeSignKitAsync();
      const stopMirror = kitRoot == null ? null : await startWinCodeSignMirror(kitRoot);
      try {
        await execFileAsync(process.execPath, [
          config.electronBuilderCliPath,
          "--win",
          "--projectDir",
          projectDir,
          "--config",
          paths.appBuilderConfigPath,
          "--publish",
          "never",
        ], {
          cwd: config.workspaceRoot,
          env: {
            ...process.env,
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            ...(kitRoot == null ? {} : winCodeSignKitEnv(kitRoot)),
            ...(webStandaloneHookConfigPath == null ? {} : { [WEB_STANDALONE_HOOK_CONFIG_ENV]: webStandaloneHookConfigPath }),
          },
        });
      } finally {
        stopMirror?.();
      }
    }, {
      electronBuilderCliPath: config.electronBuilderCliPath,
      projectDir,
      webOutputMode: config.webOutputMode,
    });
  };

  await runSegment("electron-builder-raw:ensure-nsis-persian-alias", async () => {
    await ensureNsisPersianLanguageAlias(config);
  });
  try {
    await build("electron-builder-raw:process");
  } catch (error) {
    const output = `${(error as { stdout?: unknown }).stdout ?? ""}\n${(error as { stderr?: unknown }).stderr ?? ""}`;
    const retried = output.includes("Persian.nlf") && await runSegment(
      "electron-builder-raw:retry-ensure-nsis-persian-alias",
      async () => ensureNsisPersianLanguageAlias(config),
    );
    if (retried) {
      await build("electron-builder-raw:process-retry");
      return segments;
    }
    throw error;
  }
  return segments;
}

function createCacheLocalWinPaths(paths: WinPaths, entryRoot: string): WinPaths {
  return {
    ...paths,
    appBuilderConfigPath: join(entryRoot, "builder-config.json"),
    appBuilderOutputRoot: join(entryRoot, "builder"),
    nsisIncludePath: join(entryRoot, "nsis", "installer.nsh"),
    webStandaloneHookAuditPath: join(entryRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(entryRoot, "web-standalone-after-pack-config.json"),
  };
}

function resolveCachedNsisBasePayloadInputHashPath(entryPath: string): string {
  return join(entryPath, "win-nsis-base-payload-input-hash.json");
}

async function readCachedNsisBasePayloadInputHash(entryPath: string): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(resolveCachedNsisBasePayloadInputHashPath(entryPath), "utf8"),
    ) as { hash?: unknown; version?: unknown };
    if (
      value.version === WIN_NSIS_BASE_PAYLOAD_INPUT_HASH_CACHE_VERSION
      && typeof value.hash === "string"
      && /^[0-9a-f]{64}$/.test(value.hash)
    ) {
      return value.hash;
    }
  } catch {
    // Older cache entries do not have this metadata.
  }
  return null;
}

async function resolveCachedNsisBasePayloadInputHash(
  entryPath: string,
  builtApp: WinBuiltAppManifest,
): Promise<string> {
  const cached = await readCachedNsisBasePayloadInputHash(entryPath);
  if (cached != null) return cached;

  const hash = builtApp.cacheEntryPath == null
    ? await hashWinNsisBasePayloadInputs(builtApp)
    : hashJson({
      cacheEntryPath: builtApp.cacheEntryPath,
      excludedOverlayPaths: resolveWinNsisOverlayRequiredPaths(),
      version: WIN_NSIS_BASE_PAYLOAD_INPUT_HASH_CACHE_VERSION,
    });
  await writeFile(
    resolveCachedNsisBasePayloadInputHashPath(entryPath),
    `${JSON.stringify({
      hash,
      version: WIN_NSIS_BASE_PAYLOAD_INPUT_HASH_CACHE_VERSION,
    }, null, 2)}\n`,
    "utf8",
  );
  return hash;
}

function rewriteAuditPaths(value: unknown, fromRoot: string, toRoot: string): unknown {
  if (typeof value === "string") return value.split(fromRoot).join(toRoot);
  if (Array.isArray(value)) return value.map((entry) => rewriteAuditPaths(entry, fromRoot, toRoot));
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewriteAuditPaths(entry, fromRoot, toRoot)]),
  );
}

async function materializeCachedElectronBuilderAudit(entryRoot: string, paths: WinPaths): Promise<void> {
  if (!(await pathExists(join(entryRoot, "web-standalone-after-pack-audit.json")))) return;
  const raw = JSON.parse(await readFile(join(entryRoot, "web-standalone-after-pack-audit.json"), "utf8")) as unknown;
  const appPath = typeof (raw as { appPath?: unknown }).appPath === "string"
    ? (raw as { appPath: string }).appPath
    : null;
  const sourceBuilderRoot = appPath == null ? join(entryRoot, "builder") : dirname(appPath);
  await mkdir(dirname(paths.webStandaloneHookAuditPath), { recursive: true });
  await writeFile(
    paths.webStandaloneHookAuditPath,
    `${JSON.stringify(rewriteAuditPaths(raw, sourceBuilderRoot, paths.appBuilderOutputRoot), null, 2)}\n`,
    "utf8",
  );
}

async function rewriteUnpackedAppPackageVersion(unpackedRoot: string, packagedVersion: string): Promise<void> {
  const packageJsonPath = join(unpackedRoot, "resources", "app", "package.json");
  if (!(await pathExists(packageJsonPath))) return;
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  packageJson.version = electronBuilderVersionForAppVersion(packagedVersion);
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function assertMaterializedUnpackedVersionConsistency(
  unpackedRoot: string,
  packagedVersion: string,
): Promise<void> {
  const packageJsonPath = join(unpackedRoot, "resources", "app", "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };
  const expectedPackageVersion = electronBuilderVersionForAppVersion(packagedVersion);
  if (packageJson.version !== expectedPackageVersion) {
    throw new Error(
      `expected packaged app version ${JSON.stringify(expectedPackageVersion)} in ${packageJsonPath}, received ${JSON.stringify(packageJson.version)}`,
    );
  }

  const packagedConfigPath = join(unpackedRoot, "resources", "open-design-config.json");
  const packagedConfig = JSON.parse(await readFile(packagedConfigPath, "utf8")) as { appVersion?: unknown };
  if (packagedConfig.appVersion !== packagedVersion) {
    throw new Error(
      `expected packaged config version ${JSON.stringify(packagedVersion)} in ${packagedConfigPath}, received ${JSON.stringify(packagedConfig.appVersion)}`,
    );
  }

  const executablePath = join(unpackedRoot, `${PRODUCT_NAME}.exe`);
  const executableVersionTargets = resolveWinExecutableVersionTargets(packagedVersion);
  const executableVersion = await readWinExecutableVersionSnapshot(executablePath);
  if (executableVersion.fixedFileVersion !== executableVersionTargets.numericVersion) {
    throw new Error(
      `expected unpacked executable fixed FileVersion ${executableVersionTargets.numericVersion} in ${executablePath}, received ${executableVersion.fixedFileVersion}`,
    );
  }
  if (executableVersion.fixedProductVersion !== executableVersionTargets.productVersion) {
    throw new Error(
      `expected unpacked executable fixed ProductVersion ${executableVersionTargets.productVersion} in ${executablePath}, received ${executableVersion.fixedProductVersion}`,
    );
  }
  for (const stringTable of executableVersion.stringTables) {
    if (stringTable.values.FileVersion !== executableVersionTargets.fileVersion) {
      throw new Error(
        `expected unpacked executable FileVersion string ${JSON.stringify(executableVersionTargets.fileVersion)} in ${executablePath}, received ${JSON.stringify(stringTable.values.FileVersion)}`,
      );
    }
    if (stringTable.values.ProductVersion !== executableVersionTargets.productVersion) {
      throw new Error(
        `expected unpacked executable ProductVersion string ${JSON.stringify(executableVersionTargets.productVersion)} in ${executablePath}, received ${JSON.stringify(stringTable.values.ProductVersion)}`,
      );
    }
  }
}

function winUnpackedAppRoot(unpackedRoot: string): string {
  return join(unpackedRoot, "resources", "app");
}

async function validateWinUnpackedNodePtyRuntime(unpackedRoot: string): Promise<string | null> {
  return validateNodePtyRuntime({
    appRoot: winUnpackedAppRoot(unpackedRoot),
    arch: "x64",
    platform: "win32",
  });
}

async function assertWinUnpackedNodePtyRuntime(unpackedRoot: string): Promise<void> {
  await assertNodePtyRuntime({
    appRoot: winUnpackedAppRoot(unpackedRoot),
    arch: "x64",
    platform: "win32",
  });
}

export async function materializeCachedUnpackedForInstaller(
  sourceUnpackedRoot: string,
  paths: WinPaths,
  packagedVersion?: string,
): Promise<WinBuiltAppManifest>;
export async function materializeCachedUnpackedForInstaller(
  paths: WinPaths,
  packagedVersion?: string,
): Promise<WinBuiltAppManifest>;
export async function materializeCachedUnpackedForInstaller(
  sourceUnpackedRootOrPaths: string | WinPaths,
  pathsOrPackagedVersion?: WinPaths | string,
  maybePackagedVersion?: string,
): Promise<WinBuiltAppManifest> {
  const sourceUnpackedRoot = typeof sourceUnpackedRootOrPaths === "string" ? sourceUnpackedRootOrPaths : null;
  const paths = typeof sourceUnpackedRootOrPaths === "string"
    ? pathsOrPackagedVersion as WinPaths
    : sourceUnpackedRootOrPaths;
  const packagedVersion = typeof sourceUnpackedRootOrPaths === "string"
    ? maybePackagedVersion
    : typeof pathsOrPackagedVersion === "string"
      ? pathsOrPackagedVersion
      : undefined;
  if (sourceUnpackedRoot != null) {
    await removeTree(paths.unpackedRoot);
    await mkdir(dirname(paths.unpackedRoot), { recursive: true });
    await cp(sourceUnpackedRoot, paths.unpackedRoot, { recursive: true });
  }
  await mkdir(join(paths.unpackedRoot, "resources"), { recursive: true });
  await writeFile(
    join(paths.unpackedRoot, "resources", "open-design-config.json"),
    await readFile(paths.packagedConfigPath),
  );
  if (packagedVersion != null) {
    await rewriteUnpackedAppPackageVersion(paths.unpackedRoot, packagedVersion);
    await rewriteWinExecutableVersion(paths.unpackedExePath, packagedVersion);
    await assertMaterializedUnpackedVersionConsistency(paths.unpackedRoot, packagedVersion);
  }
  await assertWinUnpackedNodePtyRuntime(paths.unpackedRoot);
  return {
    appBuilderOutputRoot: paths.appBuilderOutputRoot,
    cacheEntryPath: null,
    configPath: paths.packagedConfigPath,
    executablePath: paths.unpackedExePath,
    source: "namespace",
    unpackedRoot: paths.unpackedRoot,
    version: 1,
    webStandaloneHookAuditPath: (await pathExists(paths.webStandaloneHookAuditPath)) ? paths.webStandaloneHookAuditPath : null,
  };
}

export async function runElectronBuilder(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  packagedAppKey: string,
  getPackagedAppRoot: () => Promise<string>,
  resourceTree: ResourceTreeResult,
): Promise<WinPackTiming[]> {
  const segments: WinPackTiming[] = [];
  const runSegment = async <T>(
    phase: string,
    task: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const startedAt = Date.now();
    logWinBuildProgress("segment:start", { phase });
    try {
      const result = await task();
      logWinBuildProgress("segment:done", { durationMs: Date.now() - startedAt, phase });
      return result;
    } catch (error) {
      logWinBuildProgress("segment:failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        phase,
      });
      throw error;
    } finally {
      segments.push({ details, durationMs: Date.now() - startedAt, phase });
    }
  };
  const packagedVersion = await readPackagedVersion(config);
  const versionCore = versionCoreForAppVersion(packagedVersion);
  const usePrebundle = shouldUseWinStandalonePrebundle(config.webOutputMode);
  const packagedConfigEntrypoints = usePrebundle
    ? {
        daemonCliEntryRelative: WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
        daemonSidecarEntryRelative: WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
        webSidecarEntryRelative: WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
      }
    : {};
  const afterPackHook = config.webOutputMode === "standalone" ? await hashPath(winResources.webStandaloneAfterPackHook) : null;
  const domToPptxBundle = await hashPath(domToPptxBundleResource(config).from);
  const winIcon = await hashPath(winResources.icon);
  const electronBuilderKeyInput = {
    afterPackHook,
    cacheVersion: WIN_ELECTRON_BUILDER_DIR_CACHE_VERSION,
    domToPptxBundle,
    asar: ELECTRON_BUILDER_ASAR,
    buildDependenciesFromSource: ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE,
    electronBuilderCliPath: config.electronBuilderCliPath,
    electronVersion: config.electronVersion,
    nodeGypRebuild: ELECTRON_BUILDER_NODE_GYP_REBUILD,
    npmRebuild: ELECTRON_BUILDER_NPM_REBUILD,
    packagedAppKey,
    packagedConfigSchemaVersion: usePrebundle ? 2 : 1,
    portable: config.portable,
    platform: "win32",
    packagedVersionScope: versionCore,
    resourceTreeKey: resourceTree.key,
    target: "dir",
    webOutputMode: config.webOutputMode,
    winIcon,
    filePatterns: ELECTRON_BUILDER_FILE_PATTERNS,
  };
  const key = hashJson({
    ...electronBuilderKeyInput,
    node: "win.electron-builder-dir",
  });
  const builderVersionScopeKey = hashJson({
    ...electronBuilderKeyInput,
    node: "win.electron-builder-dir-base",
    packagedVersion: versionCore,
  });
  const assertSidecarRuntime = (unpackedRoot: string) => assertPackagedSidecarRuntime(winUnpackedAppRoot(unpackedRoot), [
    "main.cjs",
    ...(usePrebundle ? [WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH, WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH, WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH].map((entry) => entry.slice("app/".length)) : []),
  ]);
  const auditOutput = "web-standalone-after-pack-audit.json";
  const node = {
    id: "win.electron-builder-dir",
    key,
    outputs: ["builder", ...(config.webOutputMode === "standalone" ? [auditOutput] : [])],
    invalidate: async ({ entryRoot }: { entryRoot: string }) => {
      const validationError = await validateWinUnpackedNodePtyRuntime(
        join(entryRoot, "builder", "win-unpacked"),
      );
      if (validationError != null) return { reason: validationError };
      try { await assertSidecarRuntime(join(entryRoot, "builder", "win-unpacked")); }
      catch (error) { return { reason: String(error) }; }
      return null;
    },
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ElectronBuilderDirCacheMetadata> => {
      const packagedAppRoot = await getPackagedAppRoot();
      await runElectronBuilderRaw(
        { ...config, to: "dir" },
        { ...createCacheLocalWinPaths(paths, entryRoot), resourceRoot: resourceTree.resourceRoot },
        packagedAppRoot,
      );
      await assertWinUnpackedNodePtyRuntime(join(entryRoot, "builder", "win-unpacked"));
      await assertSidecarRuntime(join(entryRoot, "builder", "win-unpacked"));
      return { packagedAppKey, packagedVersion };
    },
  };
  let manifest = await runSegment("electron-builder-dir:read-hit", async () =>
    cache.readHit({
      materialize: [],
      node,
    })
  );
  if (manifest == null) {
    const packagedAppRoot = await runSegment("packaged-app:prepare", async () => getPackagedAppRoot());
    manifest = await runSegment("electron-builder-dir:acquire", async () =>
      cache.acquire({
        materialize: [],
        node: {
          ...node,
          build: async ({ entryRoot }: { entryRoot: string }): Promise<ElectronBuilderDirCacheMetadata> => {
            await runSegment("electron-builder-dir:build-raw", async () => {
              const rawSegments = await runElectronBuilderRaw(
                { ...config, to: "dir" },
                { ...createCacheLocalWinPaths(paths, entryRoot), resourceRoot: resourceTree.resourceRoot },
                packagedAppRoot,
              );
              segments.push(...rawSegments);
              await assertWinUnpackedNodePtyRuntime(join(entryRoot, "builder", "win-unpacked"));
              await assertSidecarRuntime(join(entryRoot, "builder", "win-unpacked"));
            });
            return { packagedAppKey, packagedVersion };
          },
        },
      })
    );
  }

  const cachedBuilderRoot = join(manifest.entryPath, "builder");
  const cachedUnpackedRoot = join(cachedBuilderRoot, "win-unpacked");
  const cachedExecutablePath = join(cachedUnpackedRoot, `${PRODUCT_NAME}.exe`);
  await runSegment("electron-builder-dir:validate-node-pty-runtime", async () => {
    await assertWinUnpackedNodePtyRuntime(cachedUnpackedRoot);
    await assertSidecarRuntime(cachedUnpackedRoot);
  });
  await runSegment("electron-builder-dir:prepare-namespace", async () => {
    if (shouldBuildWinNsisInstaller(config.to) || shouldBuildWinPortableZip(config.to)) {
      await mkdir(paths.appBuilderOutputRoot, { recursive: true });
    } else {
      await removeTree(paths.appBuilderOutputRoot);
    }
    await writePackagedConfig(config, paths, packagedVersion, packagedConfigEntrypoints);
  });
  await runSegment("electron-builder-dir:materialize-audit", async () => {
    await materializeCachedElectronBuilderAudit(manifest.entryPath, paths);
  });
  await runSegment("electron-builder-dir:write-manifest", async () => {
    await writeBuiltAppManifest(paths, {
      appBuilderOutputRoot: cachedBuilderRoot,
      cacheEntryPath: manifest.entryPath,
      configPath: paths.packagedConfigPath,
      executablePath: cachedExecutablePath,
      source: "cache",
      unpackedRoot: cachedUnpackedRoot,
      webStandaloneHookAuditPath: (await pathExists(paths.webStandaloneHookAuditPath)) ? paths.webStandaloneHookAuditPath : null,
    });
  });
  if (shouldBuildWinNsisInstaller(config.to) || shouldBuildWinPortableZip(config.to)) {
    const signingCacheKey = resolveWinSigningCacheKey(config);
    const nsisInstallerImplementation = shouldBuildWinNsisInstaller(config.to)
      ? await runSegment("nsis-installer:implementation-hash", () => hashWinNsisInstallerImplementation(config))
      : null;
    const nsisSetupMaterialize = [
      { from: "setup.exe", reuse: true, to: paths.setupPath },
    ];
    const nsisBasePayloadMaterialize = [
      { from: "payload-base.7z", reuse: true, to: paths.installerBasePayloadPath },
    ];
    const nsisOverlayPayloadMaterialize = [
      { from: "payload-overlay.7z", reuse: true, to: paths.installerOverlayPayloadPath },
    ];
    const createNsisBasePayloadNode = (
      materialized: WinBuiltAppManifest | null,
      archiveSegments: WinPackTiming[],
      basePayloadInputHash: string | null = null,
    ): CacheNode<{ createdAt: string; payloadPath: string; versionCore: string }> => ({
      build: async ({ entryRoot }) => {
        if (materialized == null) throw new Error("cannot build NSIS base payload without materialized unpacked app");
        archiveSegments.push(...await buildWinNsisBasePayload(paths, materialized));
        await cp(paths.installerBasePayloadPath, join(entryRoot, "payload-base.7z"));
        return {
          createdAt: new Date().toISOString(),
          payloadPath: paths.installerBasePayloadPath,
          versionCore,
        };
      },
      id: "win.nsis-payload-base",
      invalidate: async () => null,
      key: hashJson({
        archiveCacheVersion: WIN_ARCHIVE_CACHE_VERSION,
        basePayloadInputHash,
        builderVersionScopeKey: basePayloadInputHash == null ? builderVersionScopeKey : null,
        namespace: config.namespace,
        target: "nsis-payload-base",
        versionCore,
      }),
      outputs: ["payload-base.7z"],
    });
    const createNsisOverlayPayloadNode = (
      materialized: WinBuiltAppManifest | null,
      archiveSegments: WinPackTiming[],
      ensureSignedUnpacked: () => Promise<void>,
    ): CacheNode<{ createdAt: string; payloadPath: string }> => ({
      build: async ({ entryRoot }) => {
        if (materialized == null) throw new Error("cannot build NSIS overlay payload without materialized unpacked app");
        await ensureSignedUnpacked();
        archiveSegments.push(...await buildWinNsisOverlayPayload(paths, materialized));
        await cp(paths.installerOverlayPayloadPath, join(entryRoot, "payload-overlay.7z"));
        return {
          createdAt: new Date().toISOString(),
          payloadPath: paths.installerOverlayPayloadPath,
        };
      },
      id: "win.nsis-payload-overlay",
      invalidate: async () => null,
      key: hashJson({
        archiveCacheVersion: WIN_ARCHIVE_CACHE_VERSION,
        key,
        namespace: config.namespace,
        packagedVersion,
        signing: signingCacheKey,
        target: "nsis-payload-overlay",
      }),
      outputs: ["payload-overlay.7z"],
    });
    const nsisBasePayloadNode = createNsisBasePayloadNode(null, []);
    const nsisOverlayPayloadNode = createNsisOverlayPayloadNode(null, [], async () => undefined);
    const createNsisInstallerNode = (
      archiveSegments: WinPackTiming[],
      basePayloadKey: string,
      overlayPayloadKey: string,
    ): CacheNode<{ createdAt: string; installerPath: string }> => ({
      build: async ({ entryRoot }) => {
        archiveSegments.push(...await buildCustomWinNsisInstaller(config, paths));
        await cp(paths.setupPath, join(entryRoot, "setup.exe"));
        return {
          createdAt: new Date().toISOString(),
          installerPath: paths.setupPath,
        };
      },
      id: "win.nsis-installer",
      invalidate: async () => null,
      key: hashJson({
        archiveCacheVersion: WIN_ARCHIVE_CACHE_VERSION,
        basePayloadKey,
        namespace: config.namespace,
        nsisInstallerImplementation,
        overlayPayloadKey,
        packagedVersion,
        signing: signingCacheKey,
        target: "nsis-installer",
        winIcon,
      }),
      outputs: ["setup.exe"],
    });

    const basePayloadInputHash = shouldBuildWinNsisInstaller(config.to)
      ? await runSegment("nsis-payload-base:input-hash", async () =>
        resolveCachedNsisBasePayloadInputHash(
          manifest.entryPath,
          {
            appBuilderOutputRoot: cachedBuilderRoot,
            cacheEntryPath: manifest.entryPath,
            configPath: paths.packagedConfigPath,
            executablePath: cachedExecutablePath,
            source: "cache",
            unpackedRoot: cachedUnpackedRoot,
            version: 1,
            webStandaloneHookAuditPath: null,
          },
        )
      )
      : null;

    const contentKeyedBasePayloadNode = basePayloadInputHash == null
      ? null
      : createNsisBasePayloadNode(null, [], basePayloadInputHash);
    if (shouldBuildWinNsisInstaller(config.to) && !shouldBuildWinPortableZip(config.to)) {
      if (contentKeyedBasePayloadNode == null) throw new Error("missing NSIS base payload input hash");
      const nsisHitSegments: WinPackTiming[] = [];
      const nsisHit = await runSegment("nsis-installer:read-hit", async () =>
        cache.readHit({
          materialize: nsisSetupMaterialize,
          node: createNsisInstallerNode(nsisHitSegments, contentKeyedBasePayloadNode.key, nsisOverlayPayloadNode.key),
        })
      );
      if (nsisHit != null) {
        segments.push(...nsisHitSegments);
        return segments;
      }
    }

    let basePayloadHit = false;
    let overlayPayloadHit = false;
    if (shouldBuildWinNsisInstaller(config.to)) {
      if (basePayloadInputHash == null || contentKeyedBasePayloadNode == null) {
        throw new Error("missing NSIS base payload input hash");
      }
      const basePayloadProbeSegments: WinPackTiming[] = [];
      const basePayloadProbeNode = createNsisBasePayloadNode(null, basePayloadProbeSegments, basePayloadInputHash);
      const basePayloadProbe = await runSegment("nsis-payload-base:read-hit", async () =>
        cache.readHit({
          materialize: nsisBasePayloadMaterialize,
          node: basePayloadProbeNode,
        })
      );
      basePayloadHit = basePayloadProbe != null;
      segments.push(...basePayloadProbeSegments);

      const overlayPayloadProbeSegments: WinPackTiming[] = [];
      const overlayPayloadProbe = await runSegment("nsis-payload-overlay:read-hit", async () =>
        cache.readHit({
          materialize: nsisOverlayPayloadMaterialize,
          node: createNsisOverlayPayloadNode(null, overlayPayloadProbeSegments, async () => undefined),
        })
      );
      overlayPayloadHit = overlayPayloadProbe != null;
      segments.push(...overlayPayloadProbeSegments);

      if (basePayloadHit && overlayPayloadHit && !shouldBuildWinPortableZip(config.to)) {
        const installerSegments: WinPackTiming[] = [];
        await runSegment("nsis-installer:cache", async () => {
          await cache.acquire({
            materialize: nsisSetupMaterialize,
            node: createNsisInstallerNode(installerSegments, contentKeyedBasePayloadNode.key, nsisOverlayPayloadNode.key),
          });
        });
        segments.push(...installerSegments);
        return segments;
      }
    }

    const materialized = await runSegment("installer:materialize-unpacked", async () => {
      const materializedManifest = await cache.readHit({
        materialize: [{
          from: "builder/win-unpacked",
          reuse: true,
          reuseRequiredPaths: [
            ...resolveWinNsisOverlayRequiredPaths(),
            [
              "resources/open-design-web-standalone/apps/web/server.js",
              "resources/open-design-web-standalone/server.js",
            ],
          ],
          to: paths.unpackedRoot,
        }],
        node,
      });
      if (materializedManifest == null) {
        throw new Error("electron builder cache entry disappeared before installer materialization");
      }
      return materializeCachedUnpackedForInstaller(paths, packagedVersion);
    });
    let signedUnpacked = false;
    const ensureSignedUnpacked = async (): Promise<void> => {
      if (!config.signed || signedUnpacked) return;
      const signingDetails: Record<string, unknown> = {};
      await runSegment("windows-sign:unpacked-exe", async () => {
        // The final installer still gets a full sign+verify pass; skip the
        // redundant local verify on the intermediate unpacked exe.
        Object.assign(signingDetails, await signAndVerifyWinFile(materialized.executablePath, { verify: false }));
      }, signingDetails);
      signedUnpacked = true;
    };
    if (shouldBuildWinPortableZip(config.to)) {
      const archiveSegments: WinPackTiming[] = [];
      await runSegment("portable-zip:cache", async () => {
        const portableZipNode: CacheNode<{ createdAt: string; portableZipPath: string }> = {
          build: async ({ entryRoot }) => {
            await ensureSignedUnpacked();
            archiveSegments.push(...await buildWinPortableZip(config, paths, materialized));
            await cp(paths.setupZipPath, join(entryRoot, "portable.zip"));
            return { createdAt: new Date().toISOString(), portableZipPath: paths.setupZipPath };
          },
          id: "win.portable-zip",
          invalidate: async () => null,
          key: hashJson({
            archiveCacheVersion: WIN_ARCHIVE_CACHE_VERSION,
            namespace: config.namespace,
            packagedAppKey,
            packagedVersion,
            signing: signingCacheKey,
            target: "portable-zip",
          }),
          outputs: ["portable.zip"],
        };
        await cache.acquire({
          materialize: [{ from: "portable.zip", reuse: true, to: paths.setupZipPath }],
          node: portableZipNode,
        });
      });
      segments.push(...archiveSegments);
    }
    if (shouldBuildWinNsisInstaller(config.to)) {
      if (basePayloadInputHash == null || contentKeyedBasePayloadNode == null) {
        throw new Error("missing NSIS base payload input hash");
      }
      if (!basePayloadHit) {
        const basePayloadSegments: WinPackTiming[] = [];
        await runSegment("nsis-payload-base:cache", async () => {
          await cache.acquire({
            materialize: nsisBasePayloadMaterialize,
            node: createNsisBasePayloadNode(materialized, basePayloadSegments, basePayloadInputHash),
          });
        });
        segments.push(...basePayloadSegments);
      }
      if (!overlayPayloadHit) {
        const overlayPayloadSegments: WinPackTiming[] = [];
        await runSegment("nsis-payload-overlay:cache", async () => {
          await cache.acquire({
            materialize: nsisOverlayPayloadMaterialize,
            node: createNsisOverlayPayloadNode(materialized, overlayPayloadSegments, ensureSignedUnpacked),
          });
        });
        segments.push(...overlayPayloadSegments);
      }
      const installerSegments: WinPackTiming[] = [];
      await runSegment("nsis-installer:cache", async () => {
        await cache.acquire({
          materialize: nsisSetupMaterialize,
          node: createNsisInstallerNode(installerSegments, contentKeyedBasePayloadNode.key, nsisOverlayPayloadNode.key),
        });
      });
      segments.push(...installerSegments);
    }
  }
  return segments;
}
