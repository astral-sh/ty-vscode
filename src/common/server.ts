import * as fsapi from "fs-extra";
import { platform } from "os";
import * as vscode from "vscode";
import { Disposable, l10n, LanguageStatusSeverity, OutputChannel } from "vscode";
import { MessageType, ShowMessageNotification, State } from "vscode-languageclient";
import { LanguageClient, RevealOutputChannelOn } from "vscode-languageclient/node";
import { BINARY_NAME, BUNDLED_EXECUTABLE, SERVER_SUBCOMMAND } from "./constants";
import { logger } from "./logger";
import { getExtensionSettings, getGlobalSettings, ISettings } from "./settings";
import { updateStatus } from "./status";
import { getDocumentSelector } from "./utilities";
import which = require("which");

export type IInitializationOptions = {
  settings: ISettings[];
  globalSettings: ISettings;
};

/**
 * Check if shell mode is required for `execFile`.
 *
 * The conditions are:
 * - Windows OS
 * - File extension is `.cmd` or `.bat`
 */
export function execFileShellModeRequired(file: string) {
  file = file.toLowerCase();
  return platform() === "win32" && (file.endsWith(".cmd") || file.endsWith(".bat"));
}

/**
 * Finds the Ruff binary path and returns it.
 *
 * The strategy is as follows:
 * 1. If the 'path' setting is set, check each path in order. The first valid
 *    path is returned.
 * 2. If the 'importStrategy' setting is 'useBundled', return the bundled
 *    executable path.
 * 3. Otherwise, look for the executable in the `.venv` directory.
 * 4. Otherwise, check the global environment, which checks the PATH environment variable.
 * 5. If all else fails, return the bundled executable path.
 */
async function findBinaryPath(
  settings: ISettings,
  projectRoot: vscode.WorkspaceFolder,
): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    logger.info(`Workspace is not trusted, using bundled executable: ${BUNDLED_EXECUTABLE}`);
    return BUNDLED_EXECUTABLE;
  }

  // First choice: 'path' setting
  if (settings.path.length > 0) {
    for (const path of settings.path) {
      if (await fsapi.pathExists(path)) {
        logger.info(`Using 'path' setting: ${path}`);
        return path;
      }
    }
    logger.info(`Could not find executable in 'path': ${settings.path.join(", ")}`);
  }

  if (settings.importStrategy === "useBundled") {
    logger.info(`Using bundled executable: ${BUNDLED_EXECUTABLE}`);
    return BUNDLED_EXECUTABLE;
  }

  // Second choice: the `.venv` directory.
  // STOPSHIP(charlie): Discover the `.venv` directory.

  // Third choice: the executable in the global environment.
  const environmentPath = await which(BINARY_NAME, { nothrow: true });
  if (environmentPath) {
    logger.info(`Using environment executable: ${environmentPath}`);
    return environmentPath;
  }

  // Third choice: bundled executable.
  logger.info(`Falling back to bundled executable: ${BUNDLED_EXECUTABLE}`);
  return BUNDLED_EXECUTABLE;
}

async function createServer(
  projectRoot: vscode.WorkspaceFolder,
  settings: ISettings,
  serverId: string,
  serverName: string,
  outputChannel: OutputChannel,
  traceOutputChannel: OutputChannel,
  initializationOptions: IInitializationOptions,
): Promise<LanguageClient> {
  const binaryPath = await findBinaryPath(settings, projectRoot);
  logger.info(`Found executable at ${binaryPath}`);

  let serverArgs: string[] = [SERVER_SUBCOMMAND];
  logger.info(`Server run command: ${[binaryPath, ...serverArgs].join(" ")}`);

  let serverOptions = {
    command: binaryPath,
    args: serverArgs,
    options: { cwd: settings.cwd, env: process.env },
  };

  const clientOptions = {
    // Register the server for python documents
    documentSelector: getDocumentSelector(),
    outputChannel,
    traceOutputChannel,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions,
  };

  return new LanguageClient(serverId, serverName, serverOptions, clientOptions);
}

let _disposables: Disposable[] = [];

export async function startServer(
  projectRoot: vscode.WorkspaceFolder,
  workspaceSettings: ISettings,
  serverId: string,
  serverName: string,
  outputChannel: OutputChannel,
  traceOutputChannel: OutputChannel,
): Promise<LanguageClient | undefined> {
  updateStatus(undefined, LanguageStatusSeverity.Information, true);

  const extensionSettings = await getExtensionSettings(serverId);
  for (const settings of extensionSettings) {
    logger.info(`Workspace settings for ${settings.cwd}: ${JSON.stringify(settings, null, 4)}`);
  }
  const globalSettings = await getGlobalSettings(serverId);
  logger.info(`Global settings: ${JSON.stringify(globalSettings, null, 4)}`);

  let newLSClient = await createServer(
    projectRoot,
    workspaceSettings,
    serverId,
    serverName,
    outputChannel,
    traceOutputChannel,
    {
      settings: extensionSettings,
      globalSettings: globalSettings,
    },
  );
  logger.info(`Server: Start requested.`);

  _disposables.push(
    newLSClient.onDidChangeState((e) => {
      switch (e.newState) {
        case State.Stopped:
          logger.debug(`Server State: Stopped`);
          break;
        case State.Starting:
          logger.debug(`Server State: Starting`);
          break;
        case State.Running:
          logger.debug(`Server State: Running`);
          updateStatus(undefined, LanguageStatusSeverity.Information, false);
          break;
      }
    }),
    newLSClient.onNotification(ShowMessageNotification.type, (params) => {
      const showMessageMethod =
        params.type === MessageType.Error
          ? vscode.window.showErrorMessage
          : params.type === MessageType.Warning
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
      showMessageMethod(params.message, "Show Logs").then((selection) => {
        if (selection) {
          outputChannel.show();
        }
      });
    }),
  );

  try {
    await newLSClient.start();
  } catch (ex) {
    updateStatus(l10n.t("Server failed to start."), LanguageStatusSeverity.Error);
    logger.error(`Server: Start failed: ${ex}`);
    dispose();
    return undefined;
  }

  return newLSClient;
}

export async function stopServer(lsClient: LanguageClient): Promise<void> {
  logger.info(`Server: Stop requested`);
  await lsClient.stop();
  dispose();
}

function dispose(): void {
  _disposables.forEach((d) => d.dispose());
  _disposables = [];
}
