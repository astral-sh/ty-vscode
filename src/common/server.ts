import * as fsapi from "fs-extra";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import * as vscode from "vscode";
import { type Disposable, l10n, LanguageStatusSeverity, type OutputChannel } from "vscode";
import {
  DidChangeConfigurationNotification,
  type LanguageClientOptions,
  MessageType,
  type Middleware,
  ShowMessageNotification,
  State,
} from "vscode-languageclient";
import { LanguageClient, RevealOutputChannelOn } from "vscode-languageclient/node";
import {
  BINARY_NAME,
  BUNDLED_EXECUTABLE,
  FIND_BINARY_SCRIPT_PATH,
  SERVER_SUBCOMMAND,
} from "./constants";
import { logger } from "./logger";
import {
  getInitializationOptions,
  InitializationOptions,
  type ExtensionSettings,
} from "./settings";
import { updateStatus } from "./status";
import { getDocumentSelector } from "./utilities";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import which = require("which");
import { createTyMiddleware } from "../client";
import {
  checkInterpreterVersion,
  PythonEnvironmentDetails as PythonEnvironmentDetails,
  onDidChangePythonInterpreter,
  EnvironmentProvider,
} from "./python";

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
async function findBinaryPath(
  settings: ExtensionSettings,
  environmentProvider: EnvironmentProvider | null,
): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    logger.info(`Workspace is not trusted; using bundled ty executable: ${BUNDLED_EXECUTABLE}`);
    return BUNDLED_EXECUTABLE;
  }

  // 'path' setting takes priority over everything.
  if (settings.path.length > 0) {
    for (const path of settings.path) {
      if (await fsapi.pathExists(path)) {
        logger.info(`Using ty executable from \`ty.path\`: ${path}`);
        return path;
      }
    }
    logger.info(`Could not find a ty executable from \`ty.path\`: ${settings.path.join(", ")}`);
  }

  if (settings.importStrategy === "useBundled") {
    logger.info(
      `Using bundled ty executable because \`ty.importStrategy\` is set to \`useBundled\`: ${BUNDLED_EXECUTABLE}`,
    );
    return BUNDLED_EXECUTABLE;
  }

  // Otherwise, we'll call a Python script that tries to locate a binary.
  let tyBinaryPath: string | undefined;

  const userSpecifiedInterpreterPath = settings.interpreter;
  let interpreter: PythonEnvironmentDetails | null = null;
  if (environmentProvider != null) {
    if (userSpecifiedInterpreterPath != null) {
      // The user configured a path to a Python interpreter, but we need to resolve it to a
      // a Python executable (and verify that it indeed exists).
      logger.info(
        `Resolving Python interpreter from \`ty.interpreter\`: \`${userSpecifiedInterpreterPath}\``,
      );

      interpreter =
        (await environmentProvider.resolveInterpreter(userSpecifiedInterpreterPath)) ?? null;

      if (interpreter == null) {
        logger.warn(
          `\`${userSpecifiedInterpreterPath}\` (from \`ty.interpreter\`) doesn't point to a valid interpreter. Falling back to discovering the active Python environment.`,
        );
      }
    }

    if (interpreter == null) {
      // The user didn't explicitly configure `.interpreter`. Try to find the
      // Python executable by using the workspace's Python environment.
      logger.info(`Discovering Python interpreter for workspace: \`${settings.cwd.uri}\``);

      interpreter = (await environmentProvider.getActiveEnvironment(settings.cwd.uri)) ?? null;

      if (interpreter == null) {
        logger.warn(
          `No Python interpreter found; skipping lookup of the ty executable in the Python environment.
          To select a Python interpreter, open the command palette and run 'Python: Select Interpreter'.`,
        );
      }
    }
  }

  if (interpreter != null) {
    if (interpreter.executable == null) {
      logger.warn(
        `Resolved Python interpreter has no executable path: \`${userSpecifiedInterpreterPath}\``,
      );
    } else {
      logger.info(`Using Python interpreter: ${interpreter.executable}`);

      if (checkInterpreterVersion(interpreter)) {
        try {
          const stdout = await executeFile(interpreter.executable, [FIND_BINARY_SCRIPT_PATH]);
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
      }
    }
  }

  if (tyBinaryPath && tyBinaryPath.length > 0) {
    // First choice: the executable found by the script.
    logger.info(`Using ty executable discovered from Python environment: ${tyBinaryPath}`);
    return tyBinaryPath;
  }

  // Second choice: the executable in the global environment.
  const globalPath = await which(BINARY_NAME, { nothrow: true });
  if (globalPath != null) {
    logger.info(`Using ty executable from PATH: ${globalPath}`);
    return globalPath;
  }

  // Third choice: bundled executable.
  logger.info(`Falling back to bundled ty executable: ${BUNDLED_EXECUTABLE}`);
  return BUNDLED_EXECUTABLE;
}

async function createServer(
  settings: ExtensionSettings,
  serverId: string,
  serverName: string,
  outputChannel: OutputChannel,
  traceOutputChannel: OutputChannel,
  initializationOptions: InitializationOptions,
  environmentProvider: EnvironmentProvider | null,
  middleware?: Middleware,
): Promise<LanguageClient> {
  const binaryPath = await findBinaryPath(settings, environmentProvider);
  logger.info(`Using ty executable: ${binaryPath}`);

  const serverArgs: string[] = [SERVER_SUBCOMMAND];
  logger.info(`Starting ty language server with command: ${[binaryPath, ...serverArgs].join(" ")}`);

  const serverOptions = {
    command: binaryPath,
    args: serverArgs,
    options: { cwd: settings.cwd.uri.fsPath, env: process.env },
  };

  const clientOptions: LanguageClientOptions = {
    // Register the server for python documents
    documentSelector: getDocumentSelector(),
    outputChannel,
    traceOutputChannel,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions,
    middleware,
  };

  return new LanguageClient(serverId, serverName, serverOptions, clientOptions);
}

let _disposables: Disposable[] = [];

export async function startServer(
  settings: ExtensionSettings,
  serverId: string,
  serverName: string,
  outputChannel: OutputChannel,
  traceOutputChannel: OutputChannel,
  environmentProvider: EnvironmentProvider | null,
): Promise<LanguageClient | undefined> {
  updateStatus(undefined, LanguageStatusSeverity.Information, true);

  const initializationOptions = getInitializationOptions(serverId);
  logger.info(`Initialization options: ${JSON.stringify(initializationOptions, null, 4)}`);

  const middleware = createTyMiddleware(environmentProvider);

  const newLSClient = await createServer(
    settings,
    serverId,
    serverName,
    outputChannel,
    traceOutputChannel,
    initializationOptions,
    environmentProvider,
    middleware,
  );
  logger.info("Starting ty language server.");

  _disposables.push(
    newLSClient.onDidChangeState((e) => {
      switch (e.newState) {
        case State.Stopped:
          logger.debug("Server State: Stopped");
          break;
        case State.Starting:
          logger.debug("Server State: Starting");
          break;
        case State.Running:
          logger.debug("Server State: Running");
          let version = newLSClient?.initializeResult?.serverInfo?.version;
          updateStatus(undefined, LanguageStatusSeverity.Information, false, version);

          if (version != null) {
            logger.info(`ty language server version: ${version}`);
            const plusIndex = version.indexOf("+");

            // 0.14.10+96 (8cca7bb69 2025-12-27)
            if (plusIndex !== -1) {
              version = version.substring(0, plusIndex);
            }

            // ruff/0.14.10+96 (8cca7bb69 2025-12-27)
            if (version.startsWith("ruff/")) {
              // Ruff tag, version is meaningless
            } else {
              const [major, minor, patch] = version?.split(".") ?? [];

              const majorInt = parseInt(major);
              const minorInt = parseInt(minor);
              const patchInt = parseInt(patch);

              if (!isNaN(majorInt) && !isNaN(minorInt) && !isNaN(patchInt)) {
                middleware.setServerVersion(majorInt, minorInt, patchInt);
              } else {
                logger.info(
                  `Could not parse ty language server version: ${major}.${minor}.${patch}`,
                );
              }
            }
          }

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

    // TODO: Do we need this?
    onDidChangePythonInterpreter((e) => {
      // If the Python interpreter changed and the server registered for `didChangeConfiguration`,
      // notifications, send the notification to the server so that it can request the updated
      // interpreter settings.
      if (middleware.isDidChangeConfigurationRegistered()) {
        logger.debug(
          `Active Python environment for \`${e.uri}\` changed; sending didChangeConfiguration notification to the ty server.`,
        );

        newLSClient.sendNotification(DidChangeConfigurationNotification.type, undefined);
      }
    }),
  );

  try {
    await newLSClient.start();
  } catch (ex) {
    updateStatus(l10n.t("Server failed to start."), LanguageStatusSeverity.Error);
    logger.error(`Failed to start ty language server: ${ex}`);
    dispose();
    return undefined;
  }

  return newLSClient;
}

export async function stopServer(lsClient: LanguageClient): Promise<void> {
  logger.info("Stopping ty language server.");
  await lsClient.stop();
  dispose();
}

function dispose(): void {
  for (const disposable of _disposables) {
    disposable.dispose();
  }
  _disposables = [];
}
