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

type CodeAction = {
  disableRuleComment?: {
    enable?: boolean;
  };
  fixViolation?: {
    enable?: boolean;
  };
};

type Lint = {
  enable?: boolean;
  args?: string[];
  run?: Run;
  preview?: boolean;
  select?: string[];
  extendSelect?: string[];
  ignore?: string[];
};

type Format = {
  args?: string[];
  preview?: boolean;
  backend?: FormatterBackend;
};

type ConfigPreference = "editorFirst" | "filesystemFirst" | "editorOnly";

type Run = "onType" | "onSave";

type FormatterBackend = "internal" | "uv";

type NativeServer = boolean | "on" | "off" | "auto";

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
      interpreter = (await getInterpreterDetails(workspace)).path ?? [];
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
  const settings = [
    `${namespace}.importStrategy`,
    `${namespace}.interpreter`,
    `${namespace}.path`,
    `${namespace}.logLevel`,
    `${namespace}.logFile`,
    // TODO: Remove these once `workspace/didChangeConfiguration` is supported in the server
    `${namespace}.diagnosticMode`,
    `${namespace}.disableLanguageServices`,
    `${namespace}.experimental`,
    `${namespace}.inlayHints`,
  ];
  return settings.some((s) => e.affectsConfiguration(s));
}

export interface ISettings {
  nativeServer: NativeServer;
  cwd: string;
  workspace: string;
  path: string[];
  ignoreStandardLibrary: boolean;
  interpreter: string[];
  configuration: string | object | null;
  importStrategy: ImportStrategy;
  codeAction: CodeAction;
  enable: boolean;
  showNotifications: string;
  organizeImports: boolean;
  fixAll: boolean;
  lint: Lint;
  format: Format;
  exclude?: string[];
  lineLength?: number;
  configurationPreference?: ConfigPreference;
  showSyntaxErrors: boolean;
  logLevel?: LogLevel;
  logFile?: string;
}
