import { describe, expect, it } from "vitest";

import { resolvePackagedWindowTitle } from "../src/window-title.js";

describe("resolvePackagedWindowTitle", () => {
  it("keeps stable windows on the public product name", () => {
    expect(resolvePackagedWindowTitle({ appVersion: "0.10.0", namespace: "release-stable-win" })).toBe("OpenDesign X");
  });

  it("uses channel product names for non-stable release versions", () => {
    expect(resolvePackagedWindowTitle({ appVersion: "0.10.0-beta.1", namespace: "release-beta-win" })).toBe("OpenDesign X Beta");
    expect(resolvePackagedWindowTitle({ appVersion: "0.10.0-prerelease.1", namespace: "release-prerelease-win" })).toBe("OpenDesign X Prerelease");
    expect(resolvePackagedWindowTitle({ appVersion: "0.10.0-preview.1", namespace: "release-preview-win" })).toBe("OpenDesign X Preview");
  });

  it("falls back to official release namespaces when app version is unavailable", () => {
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "release-beta-win" })).toBe("OpenDesign X Beta");
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "release-prerelease-win" })).toBe("OpenDesign X Prerelease");
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "release-preview-win" })).toBe("OpenDesign X Preview");
  });

  it("derives ad hoc namespace titles from the installer display rule", () => {
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "beta-local-flow" })).toBe("OpenDesign X beta-local-flow");
  });

  it("keeps the default namespace on the plain product name", () => {
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "default" })).toBe("OpenDesign X");
  });

  it("matches the packaged window title to the installer identity per namespace", () => {
    // tools/pack/src/win/identity.ts builds displayName `OpenDesign X <namespace>`
    // for non-channel namespaces; the window must show the same name the
    // registry entry and Start Menu shortcut use.
    expect(resolvePackagedWindowTitle({ appVersion: null, namespace: "rg" })).toBe("OpenDesign X rg");
  });
});
