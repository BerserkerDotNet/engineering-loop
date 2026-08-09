import { existsSync, readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/**
 * Host-derived storage location.
 *
 * Every input here comes from the Copilot host: EXTENSION_PATH is injected into
 * the extension process, the workspace path comes from a host RPC, and the
 * plugin list comes from a host RPC. os.homedir(), COPILOT_HOME and any
 * discovery-folder path are deliberately never consulted, so the reporter can
 * only ever write inside the host's own plugin-data tree.
 */

export const STORE_FOLDER = "loop-execution-visualizer";

function readJsonSafe(path, readFile) {
  try {
    return JSON.parse(readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** `<copilot-home>/session-state/<session-id>` -> `<copilot-home>` */
export function copilotHomeFromWorkspacePath(workspacePath) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return null;
  const normalized = workspacePath.replace(/[\\/]+$/, "");
  const parent = dirname(normalized);
  if (basename(parent).toLowerCase() !== "session-state") return null;
  const home = dirname(parent);
  if (!home || home === parent) return null;
  return home;
}

/** `<plugin-root>/extensions/<ext>/extension.mjs` -> `<plugin-root>` */
export function pluginRootFromExtensionPath(extensionPath) {
  if (typeof extensionPath !== "string" || extensionPath.length === 0) return null;
  const extensionDir = dirname(extensionPath);
  const extensionsDir = dirname(extensionDir);
  if (basename(extensionsDir).toLowerCase() !== "extensions") return null;
  const root = dirname(extensionsDir);
  if (!root || root === extensionsDir) return null;
  return root;
}

/**
 * Resolves the host plugin-data directory for this extension.
 *
 * @returns {{available: true, copilotHome: string, pluginRoot: string, pluginName: string,
 *            marketplace: string, dataDir: string, storeDir: string, pluginScoped: boolean}
 *          | {available: false, reason: string}}
 */
export function resolveStorageLocation({
  extensionPath,
  workspacePath,
  plugins = [],
  extensionId = null,
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  const pluginRoot = pluginRootFromExtensionPath(extensionPath);
  if (!pluginRoot) {
    return { available: false, reason: "extension is not installed under a plugin extensions/ directory" };
  }

  const manifestPath = join(pluginRoot, "plugin.json");
  if (!fileExists(manifestPath)) {
    return { available: false, reason: `no plugin manifest at ${manifestPath}` };
  }
  const manifest = readJsonSafe(manifestPath, readFile);
  const pluginName = typeof manifest?.name === "string" && manifest.name.length > 0 ? manifest.name : null;
  if (!pluginName) {
    return { available: false, reason: `plugin manifest at ${manifestPath} has no name` };
  }

  const copilotHome = copilotHomeFromWorkspacePath(workspacePath);
  if (!copilotHome) {
    return { available: false, reason: "host did not supply a resolvable session-state workspace path" };
  }

  const match = plugins.find((p) => p && p.name === pluginName);
  const marketplace = typeof match?.marketplace === "string" && match.marketplace.length > 0
    ? match.marketplace
    : "_direct";

  const dataDir = join(copilotHome, "plugin-data", marketplace, pluginName);
  return {
    available: true,
    copilotHome,
    pluginRoot,
    pluginName,
    marketplace,
    dataDir,
    storeDir: join(dataDir, STORE_FOLDER),
    pluginScoped: typeof extensionId === "string" ? extensionId.startsWith("plugin:") : true,
  };
}

/**
 * Fails closed when the extension was loaded from a project or user scope
 * instead of the plugin. The approved design ships one plugin copy only.
 */
export function assertPluginScoped(extensionPath) {
  const root = pluginRootFromExtensionPath(extensionPath);
  if (!root) return { ok: false, reason: "extension path is not inside a plugin extensions/ directory" };
  const segments = String(extensionPath).split(/[\\/]+/);
  const userScoped = segments.some((s, i) => s === ".copilot" && segments[i + 1] === "extensions");
  const projectScoped = segments.some((s, i) => s === ".github" && segments[i + 1] === "extensions");
  if (userScoped) return { ok: false, reason: "loaded from the user extensions directory" };
  if (projectScoped) return { ok: false, reason: "loaded from a project .github/extensions directory" };
  return { ok: true, pluginRoot: root, reason: null };
}

export function runDirectory(storeDir, runId) {
  return join(storeDir, "runs", runId);
}

export function describeLocation(location) {
  if (!location.available) return `unavailable (${location.reason})`;
  return `${location.storeDir} [plugin ${location.pluginName}@${location.marketplace}]`;
}
