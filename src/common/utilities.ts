import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { RelativePattern, Uri, WorkspaceFolder, workspace } from "vscode";
import { DocumentSelector } from "vscode-languageclient";
import { getWorkspaceFolders, isVirtualWorkspace } from "./vscodeapi";

export async function getProjectRoot(): Promise<WorkspaceFolder> {
  const workspaces: readonly WorkspaceFolder[] = getWorkspaceFolders();
  if (workspaces.length === 0) {
    return {
      uri: Uri.file(process.cwd()),
      name: path.basename(process.cwd()),
      index: 0,
    };
  } else if (workspaces.length === 1) {
    return workspaces[0];
  } else {
    let rootWorkspace = workspaces[0];
    let root = undefined;
    for (const w of workspaces) {
      if (await fs.pathExists(w.uri.fsPath)) {
        root = w.uri.fsPath;
        rootWorkspace = w;
        break;
      }
    }

    for (const w of workspaces) {
      if (root && root.length > w.uri.fsPath.length && (await fs.pathExists(w.uri.fsPath))) {
        root = w.uri.fsPath;
        rootWorkspace = w;
      }
    }
    return rootWorkspace;
  }
}

export interface TyProject {
  configPath: string;
  projectDir: string;
}

export async function discoverTyConfigs(wsFolder: WorkspaceFolder): Promise<TyProject[]> {
  const uris = await workspace.findFiles(new RelativePattern(wsFolder, "**/ty.toml"));
  return uris
    .map((uri) => ({ configPath: uri.fsPath, projectDir: path.dirname(uri.fsPath) }))
    .sort((a, b) => b.projectDir.length - a.projectDir.length);
}

export function getProjectDocumentSelector(projectDir: string): DocumentSelector {
  return [{ scheme: "file", language: "python", pattern: `${projectDir}/**` }];
}

let _tempDir: string | undefined;

export async function writeResolvedConfigFile(configPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = parseToml(content) as Record<string, unknown>;
    const configDir = path.dirname(configPath);

    const resolvePaths = (vals: unknown): string[] | undefined => {
      if (!Array.isArray(vals)) return undefined;
      return vals
        .filter((v): v is string => typeof v === "string")
        .map((v) => path.resolve(configDir, v));
    };

    const env = config["environment"] as Record<string, unknown> | undefined;
    if (env?.["extra-paths"])
      env["extra-paths"] = resolvePaths(env["extra-paths"]) ?? env["extra-paths"];

    const src = config["src"] as Record<string, unknown> | undefined;
    if (src?.["include"]) src["include"] = resolvePaths(src["include"]) ?? src["include"];
    if (src?.["exclude"]) src["exclude"] = resolvePaths(src["exclude"]) ?? src["exclude"];

    if (!_tempDir) _tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ty-vscode-"));
    const tempPath = path.join(_tempDir, configPath.replace(/[^a-zA-Z0-9]/g, "_") + ".toml");
    await fs.writeFile(tempPath, stringifyToml(config), "utf-8");
    return tempPath;
  } catch {
    return undefined;
  }
}

export async function cleanupTempConfigs(): Promise<void> {
  if (_tempDir) {
    await fs.remove(_tempDir).catch(() => {});
    _tempDir = undefined;
  }
}

export function getDocumentSelector(): DocumentSelector {
  return isVirtualWorkspace()
    ? [{ language: "python" }]
    : [
        { scheme: "file", language: "python" },
        { scheme: "untitled", language: "python" },
        { scheme: "vscode-notebook", language: "python" },
        { scheme: "vscode-notebook-cell", language: "python" },
      ];
}
