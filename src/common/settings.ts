import {
  ConfigurationChangeEvent,
  ConfigurationScope,
  WorkspaceConfiguration,
  WorkspaceFolder,
} from "vscode";
import * as vscode from "vscode";
import { getInterpreterDetails } from "./python";
import { getConfiguration, getWorkspaceFolders } from "./vscodeapi";

type ImportStrategy = "fromEnvironment" | "useBundled";

type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface ISettings {
  cwd: string;
  workspace: string;
  path: string[];
  interpreter: string[];
  importStrategy: ImportStrategy;
  showNotifications: string;
  logLevel?: LogLevel;
  logFile?: string;
}

export function getExtensionSettings(namespace: string): Promise<ISettings[]> {
  return Promise.all(
    getWorkspaceFolders().map((workspaceFolder) =>
      getWorkspaceSettings(namespace, workspaceFolder),
    ),
  );
}

function resolveVariables(value: string[], workspace?: WorkspaceFolder): string[];
function resolveVariables(value: string, workspace?: WorkspaceFolder): string;
function resolveVariables(
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

export function getInterpreterFromSetting(namespace: string, scope?: ConfigurationScope) {
  const config = getConfiguration(namespace, scope);
  return config.get<string[]>("interpreter");
}

export async function getWorkspaceSettings(
  namespace: string,
  workspace: WorkspaceFolder,
): Promise<ISettings> {
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
    workspace: workspace.uri.toString(),
    path: resolveVariables(config.get<string[]>("path") ?? [], workspace),
    interpreter,
    importStrategy: config.get<ImportStrategy>("importStrategy") ?? "fromEnvironment",
    showNotifications: config.get<string>("showNotifications") ?? "off",
    logLevel: config.get<LogLevel>("logLevel"),
    logFile: config.get<string>("logFile"),
  };
}

function getGlobalValue<T>(config: WorkspaceConfiguration, key: string, defaultValue: T): T {
  const inspect = config.inspect<T>(key);
  return inspect?.globalValue ?? inspect?.defaultValue ?? defaultValue;
}

function getOptionalGlobalValue<T>(config: WorkspaceConfiguration, key: string): T | undefined {
  const inspect = config.inspect<T>(key);
  return inspect?.globalValue;
}

export async function getGlobalSettings(namespace: string): Promise<ISettings> {
  const config = getConfiguration(namespace);
  return {
    cwd: process.cwd(),
    workspace: process.cwd(),
    path: getGlobalValue<string[]>(config, "path", []),
    interpreter: [],
    importStrategy: getGlobalValue<ImportStrategy>(config, "importStrategy", "fromEnvironment"),
    showNotifications: getGlobalValue<string>(config, "showNotifications", "off"),
    logLevel: getOptionalGlobalValue<LogLevel>(config, "logLevel"),
    logFile: getOptionalGlobalValue<string>(config, "logFile"),
  };
}

export function checkIfConfigurationChanged(
  e: ConfigurationChangeEvent,
  namespace: string,
): boolean {
  const settings = [
    `${namespace}.importStrategy`,
    `${namespace}.interpreter`,
    `${namespace}.path`,
    `${namespace}.showNotifications`,
    `${namespace}.logLevel`,
    `${namespace}.logFile`,
  ];
  return settings.some((s) => e.affectsConfiguration(s));
}
