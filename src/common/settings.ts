import type {
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

type PythonSettings = {
  ty?: {
    disableLanguageServices?: boolean;
  };
};

type DiagnosticMode = "openFilesOnly" | "workspace";

export interface ISettings {
  cwd: string;
  workspace: string;
  path: string[];
  interpreter: string[];
  importStrategy: ImportStrategy;
  diagnosticMode: DiagnosticMode;
  logLevel?: LogLevel;
  logFile?: string;
  python?: PythonSettings;
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

function getPythonSettings(workspace?: WorkspaceFolder): PythonSettings | undefined {
  const config = getConfiguration("python", workspace?.uri);
  const disableLanguageServices = config.get<boolean>("ty.disableLanguageServices");
  if (disableLanguageServices !== undefined) {
    return {
      ty: {
        disableLanguageServices,
      },
    };
  }

  return undefined;
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
    diagnosticMode: config.get<DiagnosticMode>("diagnosticMode") ?? "openFilesOnly",
    logLevel: config.get<LogLevel>("logLevel"),
    logFile: config.get<string>("logFile"),
    python: getPythonSettings(workspace),
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
    diagnosticMode: getGlobalValue<DiagnosticMode>(config, "diagnosticMode", "openFilesOnly"),
    logLevel: getOptionalGlobalValue<LogLevel>(config, "logLevel"),
    logFile: getOptionalGlobalValue<string>(config, "logFile"),
    python: getPythonSettings(),
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
    `${namespace}.logLevel`,
    `${namespace}.logFile`,
    `${namespace}.diagnosticMode`,
    "python.ty.disableLanguageServices",
  ];
  return settings.some((s) => e.affectsConfiguration(s));
}
