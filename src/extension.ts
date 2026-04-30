import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { LazyOutputChannel, logger } from "./common/logger";
import {
  getEnvironmentProvider,
  onDidChangeActivePythonEnvironment,
  OnDidChangeActivePythonEnvironmentEventArgs,
} from "./common/python";
import { findBinaryPath, type ServerState, startServer, stopServer } from "./common/server";
import { checkIfConfigurationChanged, getExtensionSettings } from "./common/settings";
import { loadServerDefaults } from "./common/setup";
import { registerLanguageStatusItem } from "./common/status";
import { getProjectRoot } from "./common/utilities";
import {
  onDidChangeConfiguration,
  onDidGrantWorkspaceTrust,
  registerCommand,
} from "./common/vscodeapi";
import { createDebugInformationProvider } from "./common/commands";

let serverState: ServerState | null = null;
let restartQueued = false;
let restartPromise: Promise<void> | null = null;

function getClient(): LanguageClient | undefined {
  return serverState?.client;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // This is required to get server name and module. This should be
  // the first thing that we do in this extension.
  const serverInfo = loadServerDefaults();
  const serverName = serverInfo.name;
  const serverId = serverInfo.module;

  // Log Server information
  logger.info(`Name: ${serverInfo.name}`);
  logger.info(`Module: ${serverInfo.module}`);
  logger.debug(`Full Server Info: ${JSON.stringify(serverInfo)}`);

  // Create output channels for the server and trace logs
  const outputChannel = vscode.window.createOutputChannel(`${serverName} Language Server`);
  const traceOutputChannel = new LazyOutputChannel(`${serverName} Language Server Trace`);

  // Make sure that these channels are disposed when the extension is deactivated.
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(traceOutputChannel);
  context.subscriptions.push(logger.channel);

  //support for debug command.
  context.subscriptions.push(
    registerCommand(
      `${serverId}.debugInformation`,
      createDebugInformationProvider(getClient, serverId, context),
    ),
  );

  const environmentProvider = await getEnvironmentProvider();

  const runServer = async () => {
    if (serverState != null) {
      await stopServer(serverState.client);
      serverState = null;
    }

    const projectRoot = await getProjectRoot();
    const settings = await getExtensionSettings(serverId, projectRoot);

    serverState = await startServer(
      settings,
      serverId,
      serverName,
      outputChannel,
      traceOutputChannel,
      environmentProvider,
    );
  };

  const requestRestart = async () => {
    if (restartPromise != null) {
      if (!restartQueued) {
        // Schedule a new restart after the current restart.
        logger.info(
          `${serverName} restart requested while another restart is in progress; queuing one more restart.`,
        );
        restartQueued = true;
      }
      await restartPromise;
      return;
    }

    restartQueued = false;
    restartPromise = (async () => {
      try {
        do {
          restartQueued = false;
          await runServer();
        } while (restartQueued);
      } finally {
        // Ensure that we reset the flag in case of an error, early return, or success.
        restartPromise = null;
      }
    })();

    await restartPromise;
  };

  const maybeRestartForPythonInterpreterChange = async (
    projectRoot: vscode.WorkspaceFolder,
    interpreter: string | undefined,
  ) => {
    if (restartPromise != null) {
      logger.debug(
        `${serverName} restart is already in progress; waiting before checking the Python interpreter change.`,
      );
      await restartPromise;
    }

    if (serverState == null) {
      logger.info(
        `Unable to determine the current ${serverName} executable; restarting ${serverName}.`,
      );
      await requestRestart();
      return;
    }

    if (serverState.binaryResolution.dependsOnActiveInterpreter) {
      const settings = await getExtensionSettings(serverId, projectRoot);
      const activeEnvironment =
        (await environmentProvider?.getActiveEnvironment(projectRoot.uri)) ?? null;
      const nextBinaryResolution = await findBinaryPath(
        settings,
        environmentProvider,
        activeEnvironment,
      );

      if (nextBinaryResolution.path !== serverState.binaryResolution.path) {
        logger.info(
          `Resolved ty executable changed from ${serverState.binaryResolution.path} to ${nextBinaryResolution.path}; restarting ${serverName}.`,
        );
        await requestRestart();
        return;
      }
    }

    if (interpreter != null && interpreter === serverState.activeEnvironmentPythonExecutable) {
      logger.info(
        `Skipping ${serverName} restart because the active Python environment is unchanged: ${interpreter}.`,
      );
      return;
    }

    // Once ty supports workspace/didChangeConfiguration, this can be replaced with a configuration notification.
    logger.info(`Restarting ${serverName} because the active Python environment changed.`);
    serverState.activeEnvironmentPythonExecutable = interpreter ?? null;
    await requestRestart();
  };

  context.subscriptions.push(
    onDidChangeActivePythonEnvironment(async (e: OnDidChangeActivePythonEnvironmentEventArgs) => {
      const interpreter = e.path ?? "<unknown>";

      const projectRoot = await getProjectRoot();

      if (e.uri != null && e.uri.toString() !== projectRoot.uri.toString()) {
        logger.debug(
          `Skip scoped Python interpreter for ${e.uri}; workspace root is ${projectRoot.uri}.`,
        );
        return;
      }

      logger.info(`Selected Python interpreter for workspace changed to \`${interpreter}\`.`);

      await maybeRestartForPythonInterpreterChange(projectRoot, e.path);
    }),

    onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
      // TODO(dhruvmanila): Notify the server with `DidChangeConfigurationNotification` and let
      // the server pull in the updated configuration.
      if (checkIfConfigurationChanged(e, serverId)) {
        await requestRestart();
      }
    }),
    onDidGrantWorkspaceTrust(async () => {
      await requestRestart();
    }),
    registerCommand(`${serverId}.restart`, async () => {
      await requestRestart();
    }),
    registerCommand(`${serverId}.showLogs`, () => {
      logger.channel.show();
    }),
    registerCommand(`${serverId}.showServerLogs`, () => {
      outputChannel.show();
    }),
    registerLanguageStatusItem(serverId, serverName, `${serverId}.showLogs`),
  );

  // TODO what about untrusted workspaces?
  await environmentProvider?.initialize(context.subscriptions);

  setImmediate(async () => {
    if (serverState == null && restartPromise == null) {
      await requestRestart();
    }
  });
}

export async function deactivate(): Promise<void> {
  if (serverState != null) {
    await stopServer(serverState.client);
    serverState = null;
  }
}
