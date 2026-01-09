import type {
  ConfigurationChangeEvent,
  ConfigurationScope,
  WorkspaceConfiguration,
  WorkspaceFolder,
} from "vscode";
import * as vscode from "vscode";
import { getInterpreterDetails } from "./python";
import { getConfiguration, getWorkspaceFolders } from "./vscodeapi";
import { logger } from "./logger";

type Version = { major: number; minor: number; patch: number };
type ImportStrategy = "fromEnvironment" | "useBundled";

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface InitializationOptions {
  logLevel?: LogLevel;
  logFile?: string;
}

export interface ExtensionSettings {
  cwd: string;
  path: string[];
  interpreter: string[];
  importStrategy: ImportStrategy;
}

export function resolveVariables(value: string[], workspace?: WorkspaceFolder): string[];
export function resolveVariables(value: string, workspace?: WorkspaceFolder): string;
export function resolveVariables(
  value: string | string[],
  workspace?: WorkspaceFolder,
): string | string[] | null {
  const substitutions = new Map<string, string>();
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    substitutions.set("${userHome}", home);
  }
  if (workspace) {
    substitutions.set("${workspaceFolder}", workspace.uri.fsPath);
  }
  substitutions.set("${cwd}", process.cwd());
  getWorkspaceFolders().forEach((w) => {
    substitutions.set("${workspaceFolder:" + w.name + "}", w.uri.fsPath);
  });
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      substitutions.set("${env:" + key + "}", value);
    }
  }

  if (typeof value === "string") {
    let s = value;
    for (const [key, value] of substitutions) {
      s = s.replace(key, value);
    }
    return s;
  } else {
    return value.map((s) => {
      for (const [key, value] of substitutions) {
        s = s.replace(key, value);
      }
      return s;
    });
  }
}

export function getInitializationOptions(namespace: string): InitializationOptions {
  const config = getConfiguration(namespace);
  return {
    logLevel: getOptionalGlobalValue<LogLevel>(config, "logLevel"),
    logFile: getOptionalGlobalValue<string>(config, "logFile"),
  };
}

export function getInterpreterFromSetting(namespace: string, scope?: ConfigurationScope) {
  const config = getConfiguration(namespace, scope);
  return config.get<string[]>("interpreter");
}

export async function getExtensionSettings(
  namespace: string,
  workspace: WorkspaceFolder,
): Promise<ExtensionSettings> {
  const config = getConfiguration(namespace, workspace.uri);

  let interpreter: string[] = getInterpreterFromSetting(namespace, workspace) ?? [];
  if (interpreter.length === 0) {
    if (vscode.workspace.isTrusted) {
      interpreter = (await getInterpreterDetails(workspace.uri)).path ?? [];
    }
  } else {
    interpreter = resolveVariables(interpreter, workspace);
  }

  return {
    cwd: workspace.uri.fsPath,
    path: resolveVariables(config.get<string[]>("path") ?? [], workspace),
    interpreter,
    importStrategy: config.get<ImportStrategy>("importStrategy") ?? "fromEnvironment",
  };
}

function getOptionalGlobalValue<T>(config: WorkspaceConfiguration, key: string): T | undefined {
  const inspect = config.inspect<T>(key);
  return inspect?.globalValue;
}

export function checkIfConfigurationChanged(
  e: ConfigurationChangeEvent,
  namespace: string,
): boolean {
  // If you add a new setting here, make sure to also add it to `SETTING_SUPPORTED_SINCE`.
  const settings = [
    `${namespace}.importStrategy`,
    `${namespace}.interpreter`,
    `${namespace}.path`,
    `${namespace}.logLevel`,
    `${namespace}.logFile`,

    // TODO: Remove these once `workspace/didChangeConfiguration` is supported in the server
    `${namespace}.configuration`,
    `${namespace}.configurationFile`,
    `${namespace}.diagnosticMode`,
    `${namespace}.disableLanguageServices`,
    `${namespace}.experimental`,
    `${namespace}.inlayHints`,
    `${namespace}.completions`,
    `${namespace}.showSyntaxErrors`,
  ];
  return settings.some((s) => e.affectsConfiguration(s));
}

const SETTING_SUPPORTED_SINCE: {
  [key: string]: { version: Version; defaultValue: unknown } | undefined;
} = {
  configuration: { version: { major: 0, minor: 0, patch: 6 }, defaultValue: null },
  configurationFile: { version: { major: 0, minor: 0, patch: 6 }, defaultValue: null },
  showSyntaxErrors: { version: { major: 0, minor: 0, patch: 8 }, defaultValue: true },
};

export function checkSettingSupported(
  setting: string,
  value: unknown,
  serverVersion: Version,
): boolean {
  const settingRequirements = SETTING_SUPPORTED_SINCE[setting];

  if (settingRequirements == null) {
    return true;
  }

  const { version: minVersion, defaultValue } = settingRequirements;

  if (isNewerThan(serverVersion, minVersion)) {
    return true;
  }

  // eslint-disable-next-line eqeqeq
  if (value == defaultValue) {
    return false;
  }

  const message = `Ignoring setting "${setting}" because it is not supported by your ty version (${serverVersion.major}.${serverVersion.minor}.${serverVersion.patch}). The setting was added in ${minVersion.major}.${minVersion.minor}.${minVersion.patch}.`;

  vscode.window.showWarningMessage(message);
  logger.warn(message);

  return false;
}

function isNewerThan(version: Version, compareTo: Version): boolean {
  if (version.major !== compareTo.major) {
    return version.major > compareTo.major;
  }
  if (version.minor !== compareTo.minor) {
    return version.minor > compareTo.minor;
  }
  return version.patch >= compareTo.patch;
}
