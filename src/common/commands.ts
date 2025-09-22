import * as vscode from "vscode";
import { ExecuteCommandRequest, LanguageClient } from "vscode-languageclient/node";

const ISSUE_TRACKER = "https://github.com/astral-sh/ty/issues";

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
