import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { LazyOutputChannel, logger } from "./common/logger";
import {
  getEnvironmentProvider,
  onDidChangePythonInterpreter,
  OnDidChangePythonInterpreterEventArgs,
} from "./common/python";
import { startServer, stopServer } from "./common/server";
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

let lsClient: LanguageClient | undefined;
let restartInProgress = false;
let restartQueued = false;

function getClient(): LanguageClient | undefined {
  return lsClient;
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

  if (restartInProgress) {
    if (!restartQueued) {
      // Schedule a new restart after the current restart.
      logger.info(
        `Triggered ${serverName} restart while restart is in progress; queuing a restart.`,
      );
      restartQueued = true;
    }
    return;
  }

  const environmentProvider = await getEnvironmentProvider();

  const runServer = async () => {
    if (restartInProgress) {
      if (!restartQueued) {
        // Schedule a new restart after the current restart.
        logger.info(
          `Triggered ${serverName} restart while restart is in progress; queuing a restart.`,
        );
        restartQueued = true;
      }
      return;
    }

    restartInProgress = true;

    try {
      if (lsClient) {
        await stopServer(lsClient);
      }

      const projectRoot = await getProjectRoot();
      const settings = await getExtensionSettings(serverId, projectRoot);

      lsClient = await startServer(
        settings,
        serverId,
        serverName,
        outputChannel,
        traceOutputChannel,
        environmentProvider,
      );
    } finally {
      // Ensure that we reset the flag in case of an error, early return, or success.
      restartInProgress = false;
      if (restartQueued) {
        restartQueued = false;
        await runServer();
      }
    }
  };

  context.subscriptions.push(
    onDidChangePythonInterpreter(async (e: OnDidChangePythonInterpreterEventArgs) => {
      logger.info(`onDidChangePythonInterpreter: ${e.uri} -> ${e.path}`);

      const projectRoot = await getProjectRoot();

      if (e.uri != null && e.uri.toString() !== projectRoot.uri.toString()) {
        logger.info(`Skipping change because interpreter isn't for workspace root`);
        return;
      }

      logger.info(`Selected Python interpreter changed to \`${e.path}\``);

      await runServer();
    }),

    onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
      // TODO(dhruvmanila): Notify the server with `DidChangeConfigurationNotification` and let
      // the server pull in the updated configuration.
      if (checkIfConfigurationChanged(e, serverId)) {
        await runServer();
      }
    }),
    onDidGrantWorkspaceTrust(async () => {
      await runServer();
    }),
    registerCommand(`${serverId}.restart`, async () => {
      await runServer();
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
    await runServer();
  });
}

export async function deactivate(): Promise<void> {
  if (lsClient) {
    await stopServer(lsClient);
  }
}
