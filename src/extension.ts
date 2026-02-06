import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { LazyOutputChannel, logger } from "./common/logger";
import {
  checkVersion,
  initializePython,
  onDidChangePythonInterpreter,
  resolveInterpreter,
} from "./common/python";
import { startServer, stopServer } from "./common/server";
import {
  checkIfConfigurationChanged,
  getInterpreterFromSetting,
  getExtensionSettings,
} from "./common/settings";
import { loadServerDefaults } from "./common/setup";
import { registerLanguageStatusItem, updateStatus } from "./common/status";
import {
  cleanupTempConfigs,
  discoverTyConfigs,
  getProjectDocumentSelector,
  getProjectRoot,
  writeResolvedConfigFile,
} from "./common/utilities";
import {
  onDidChangeConfiguration,
  onDidGrantWorkspaceTrust,
  registerCommand,
} from "./common/vscodeapi";
import { createDebugInformationProvider } from "./common/commands";

const clients = new Map<string, LanguageClient>();
let restartInProgress = false;
let restartQueued = false;

function getClient(): LanguageClient | undefined {
  for (const c of clients.values()) return c;
  return undefined;
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

  // Discover ty.toml files and start one LanguageClient per project. Each
  // server gets a scoped documentSelector so diagnostics don't overlap. When
  // no ty.toml files exist a single default server handles everything.

  const stopAll = async () => {
    await Promise.all([...clients.values()].map((c) => stopServer(c)));
    clients.clear();
    await cleanupTempConfigs();
  };

  const startAll = async () => {
    const projectRoot = await getProjectRoot();
    const settings = await getExtensionSettings(serverId, projectRoot);

    if (vscode.workspace.isTrusted) {
      if (settings.interpreter.length === 0) {
        updateStatus(
          vscode.l10n.t("Please select a Python interpreter."),
          vscode.LanguageStatusSeverity.Error,
        );
        logger.error(
          "Python interpreter missing:\r\n" +
            "[Option 1] Select Python interpreter using the ms-python.python.\r\n" +
            `[Option 2] Set an interpreter using "${serverId}.interpreter" setting.\r\n` +
            "Please use Python 3.8 or greater.",
        );
        return;
      }

      logger.info(`Using interpreter: ${settings.interpreter.join(" ")}`);
      const resolvedEnvironment = await resolveInterpreter(settings.interpreter);
      if (resolvedEnvironment === undefined) {
        updateStatus(
          vscode.l10n.t("Python interpreter not found."),
          vscode.LanguageStatusSeverity.Error,
        );
        logger.error(
          "Unable to find any Python environment for the interpreter path:",
          settings.interpreter.join(" "),
        );
        return;
      }

      if (!checkVersion(resolvedEnvironment)) {
        return;
      }
    }

    const projects = (
      await Promise.all(
        (vscode.workspace.workspaceFolders ?? []).map((ws) => discoverTyConfigs(ws)),
      )
    ).flat();

    logger.info(`Discovered ${projects.length} ty.toml project(s)`);

    for (const project of projects) {
      const configFile = await writeResolvedConfigFile(project.configPath);
      if (!configFile) {
        logger.warn(`Failed to resolve config: ${project.configPath}`);
        continue;
      }

      logger.info(`Starting server for project: ${project.configPath}`);
      const client = await startServer(
        settings,
        `${serverId}-${project.projectDir}`,
        `${serverName} (${project.projectDir})`,
        outputChannel,
        traceOutputChannel,
        configFile,
        getProjectDocumentSelector(project.projectDir),
        false,
      );
      if (client) {
        clients.set(project.configPath, client);
      }
    }

    if (clients.size === 0) {
      logger.info("No ty.toml projects found, starting default server");
      const client = await startServer(
        settings,
        serverId,
        serverName,
        outputChannel,
        traceOutputChannel,
      );
      if (client) {
        clients.set("default", client);
      }
    }
  };

  const runServers = async () => {
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
      await stopAll();
      await startAll();
    } finally {
      // Ensure that we reset the flag in case of an error, early return, or success.
      restartInProgress = false;
      if (restartQueued) {
        restartQueued = false;
        await runServers();
      }
    }
  };

  const tyTomlWatcher = vscode.workspace.createFileSystemWatcher("**/ty.toml");

  context.subscriptions.push(
    onDidChangePythonInterpreter(async () => {
      await runServers();
    }),
    onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
      // TODO(dhruvmanila): Notify the server with `DidChangeConfigurationNotification` and let
      // the server pull in the updated configuration.
      if (checkIfConfigurationChanged(e, serverId)) {
        await runServers();
      }
    }),
    onDidGrantWorkspaceTrust(async () => {
      await runServers();
    }),
    registerCommand(`${serverId}.restart`, async () => {
      await runServers();
    }),
    registerCommand(`${serverId}.showLogs`, () => {
      logger.channel.show();
    }),
    registerCommand(`${serverId}.showServerLogs`, () => {
      outputChannel.show();
    }),
    registerLanguageStatusItem(serverId, serverName, `${serverId}.showLogs`),
    tyTomlWatcher,
    tyTomlWatcher.onDidCreate(async () => {
      logger.info("ty.toml created, restarting servers");
      await runServers();
    }),
    tyTomlWatcher.onDidDelete(async () => {
      logger.info("ty.toml deleted, restarting servers");
      await runServers();
    }),
  );

  setImmediate(async () => {
    if (vscode.workspace.isTrusted) {
      const interpreter = getInterpreterFromSetting(serverId);
      if (interpreter === undefined || interpreter.length === 0) {
        logger.info("Python extension loading");
        await initializePython(context.subscriptions);
        logger.info("Python extension loaded");
        return; // The `onDidChangePythonInterpreter` event will trigger the server start.
      }
    }
    await runServers();
  });
}

export async function deactivate(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => stopServer(c)));
  clients.clear();
  await cleanupTempConfigs();
}
