import {
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseInstallIdentity,
} from "@open-design/release";

const DEFAULT_BASE_NAME = "Open Design";

export function resolvePackagedWindowTitle(config: { appVersion: string | null; namespace: string }): string {
  const channel =
    releaseChannelFromVersion(config.appVersion) ??
    releaseChannelFromNamespace(config.namespace);
  if (channel != null) return releaseInstallIdentity(channel).productName;
  // Non-channel namespaces follow the installer display rule
  // (`tools/pack/src/win/identity.ts`): `Open Design <namespace>` — so the
  // window title matches the installed app's registry/shortcut identity
  // instead of collapsing every local build to the stable brand.
  return config.namespace === "default" || config.namespace === ""
    ? DEFAULT_BASE_NAME
    : `${DEFAULT_BASE_NAME} ${config.namespace}`;
}
