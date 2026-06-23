import * as vscode from "vscode";
import { ExecuteCommandRequest, LanguageClient } from "vscode-languageclient/node";
import { logger } from "./logger";

const ISSUE_TRACKER = "https://github.com/astral-sh/ty/issues";

interface RunTestArgs {
  cwd: string;
  program: string;
  arguments: string[];
  filePath: string;
  testTarget: string;
}

/**
 * Creates a test runner for the `ty.RunTest` command.
 *
 * This will run the test in a new terminal.
 */
export function createRunTestProvider() {
  return async (runTest: RunTestArgs | undefined) => {
    if (runTest == null) {
      logger.error("Failed to run test: missing 'RunTest' arguments");
      vscode.window
        .showErrorMessage("Failed to run test: missing required arguments.", "Show Logs")
        .then((selection) => {
          if (selection) {
            logger.channel.show();
          }
        });
      return;
    }

    const { cwd, program, arguments: programArgs, testTarget } = runTest;
    const task = new vscode.Task(
      { type: "shell" },
      vscode.TaskScope.Workspace,
      `${testTarget}`,
      `ty`,
      new vscode.ShellExecution(program, programArgs, { cwd }),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    const execution = await vscode.tasks.executeTask(task);
    await new Promise<void>((resolve) => {
      const listener = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) {
          listener.dispose();
          if (e.exitCode !== 0) {
            logger.error(`Running test failed: ${program} ${programArgs.join(" ")}`);
          }
          resolve();
        }
      });
    });
  };
}

/**
 * Creates a debug information provider for the `ty.printDebugInformation` command.
 *
 * This will open a new editor window with the debug information considering the active editor.
 */
export function createDebugInformationProvider(
  getClient: () => LanguageClient | undefined,
  serverId: string,
  context: vscode.ExtensionContext,
) {
  let content: string | null = null;
  const eventEmitter = new vscode.EventEmitter<vscode.Uri>();

  const contentProvider: vscode.TextDocumentContentProvider = {
    onDidChange: eventEmitter.event,

    async provideTextDocumentContent(): Promise<string | null> {
      return content;
    },
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ty-server-debug", contentProvider),
  );

  return async () => {
    const uri = vscode.Uri.parse("ty-server-debug:/debug");

    const newContent = await getDebugContent(getClient, serverId);

    if (newContent === content) {
      return;
    }

    content = newContent;
    eventEmitter.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);

    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: true,
    });
  };
}

async function getDebugContent(
  getClient: () => LanguageClient | undefined,
  serverId: string,
): Promise<string | null> {
  const lsClient = getClient();
  if (lsClient == null) {
    return null;
  }

  const params = {
    command: `${serverId}.printDebugInformation`,
    arguments: [],
  };

  try {
    return await lsClient.sendRequest(ExecuteCommandRequest.type, params);
  } catch {
    vscode.window.showErrorMessage(
      `Failed to open the debug information. Please consider opening an issue at ${ISSUE_TRACKER} with steps to reproduce.`,
    );
    return null;
  }
}
