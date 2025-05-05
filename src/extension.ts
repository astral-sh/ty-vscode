import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import {
  createDebugInformationProvider,
} from "./common/commands";
import { LazyOutputChannel, logger } from "./common/logger";
import { startServer, stopServer } from "./common/server";
import { checkIfConfigurationChanged, getWorkspaceSettings } from "./common/settings";
import { loadServerDefaults } from "./common/setup";
import { registerLanguageStatusItem } from "./common/status";
import { getProjectRoot } from "./common/utilities";
import {
  onDidChangeConfiguration,
  onDidGrantWorkspaceTrust,
  registerCommand,
} from "./common/vscodeapi";

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

  context.subscriptions.push(
    onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ruff.enable")) {
        vscode.window.showWarningMessage(
          "To enable or disable Ruff after changing the `enable` setting, you must restart VS Code.",
        );
      }
    }),
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
      const workspaceSettings = await getWorkspaceSettings(serverId, projectRoot);

      lsClient = await startServer(
        projectRoot,
        workspaceSettings,
        serverId,
        serverName,
        outputChannel,
        traceOutputChannel,
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
    onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
      if (checkIfConfigurationChanged(e, serverId)) {
        await runServer();
      }
    }),
    onDidGrantWorkspaceTrust(async () => {
      await runServer();
    }),
    registerCommand(`${serverId}.showLogs`, () => {
      logger.channel.show();
    }),
    registerCommand(`${serverId}.showServerLogs`, () => {
      outputChannel.show();
    }),
    registerCommand(
      `${serverId}.debugInformation`,
      createDebugInformationProvider(getClient, serverId, context),
    ),
    registerLanguageStatusItem(serverId, serverName, `${serverId}.showLogs`),
  );

  setImmediate(async () => {
    await runServer();
  });
}

export async function deactivate(): Promise<void> {
  if (lsClient) {
    await stopServer(lsClient);
  }
}
