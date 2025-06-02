import * as fsapi from "fs-extra";
import { execFile } from "node:child_process";
import { platform } from "os";
import * as vscode from "vscode";
import { Disposable, l10n, LanguageStatusSeverity, OutputChannel } from "vscode";
import { MessageType, ShowMessageNotification, State } from "vscode-languageclient";
import { LanguageClient, RevealOutputChannelOn } from "vscode-languageclient/node";
import {
  BINARY_NAME,
  BUNDLED_EXECUTABLE,
  FIND_BINARY_SCRIPT_PATH,
  SERVER_SUBCOMMAND,
} from "./constants";
import { logger } from "./logger";
import { getExtensionSettings, getGlobalSettings, ISettings } from "./settings";
import { updateStatus } from "./status";
import { getDocumentSelector } from "./utilities";

// eslint-disable-next-line @typescript-eslint/no-require-imports
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
 * Function to execute a command and return the stdout.
 */
function executeFile(file: string, args: string[] = []): Promise<string> {
  const shell = execFileShellModeRequired(file);
  return new Promise((resolve, reject) => {
    execFile(shell ? `"${file}"` : file, args, { shell }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Finds the `ty` binary path and returns it.
 *
 * The strategy is as follows:
 * 1. If the 'path' setting is set, check each path in order. The first valid
 *    path is returned.
 * 2. If the 'importStrategy' setting is 'useBundled', return the bundled
 *    executable path.
 * 3. Execute a Python script that tries to locate the binary. This uses either
 *    the user-provided interpreter or the interpreter provided by the Python
 *    extension.
 * 4. If the Python script doesn't return a path, check the global environment
 *    which checks the PATH environment variable.
 * 5. If all else fails, return the bundled executable path.
 */
async function findBinaryPath(settings: ISettings): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    logger.info(`Workspace is not trusted, using bundled executable: ${BUNDLED_EXECUTABLE}`);
    return BUNDLED_EXECUTABLE;
  }

  // 'path' setting takes priority over everything.
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

  // Otherwise, we'll call a Python script that tries to locate a binary.
  let tyBinaryPath: string | undefined;
  try {
    const stdout = await executeFile(settings.interpreter[0], [FIND_BINARY_SCRIPT_PATH]);
    tyBinaryPath = stdout.trim();
  } catch (err) {
    vscode.window
      .showErrorMessage(
        "Unexpected error while trying to find the ty binary. See the logs for more details.",
        "Show Logs",
      )
      .then((selection) => {
        if (selection) {
          logger.channel.show();
        }
      });
    logger.error(`Error while trying to find the ty binary: ${err}`);
  }

  if (tyBinaryPath && tyBinaryPath.length > 0) {
    // First choice: the executable found by the script.
    logger.info(`Using the ty binary: ${tyBinaryPath}`);
    return tyBinaryPath;
  }

  // Second choice: the executable in the global environment.
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
  settings: ISettings,
  serverId: string,
  serverName: string,
  outputChannel: OutputChannel,
  traceOutputChannel: OutputChannel,
  initializationOptions: IInitializationOptions,
): Promise<LanguageClient> {
  const binaryPath = await findBinaryPath(settings);
  logger.info(`Found executable at ${binaryPath}`);

  const serverArgs: string[] = [SERVER_SUBCOMMAND];
  logger.info(`Server run command: ${[binaryPath, ...serverArgs].join(" ")}`);

  const serverOptions = {
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

  const newLSClient = await createServer(
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
