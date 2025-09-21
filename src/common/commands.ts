import * as vscode from "vscode";
import { ExecuteCommandRequest, LanguageClient } from "vscode-languageclient/node";
import { getConfiguration } from "./vscodeapi";
import { ISettings } from "./settings";

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
  const configuration = getConfiguration(serverId) as unknown as ISettings;
  if (configuration.nativeServer === false || configuration.nativeServer === "off") {
    return async () => {
      vscode.window.showInformationMessage(
        "Debug information is only available when using the native server",
      );
    };
  }

  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    readonly uri = vscode.Uri.parse("ty-server-debug://debug");
    readonly eventEmitter = new vscode.EventEmitter<vscode.Uri>();

    async provideTextDocumentContent(): Promise<string> {
      const lsClient = getClient();
      if (!lsClient) {
        return "";
      }
      const textEditor = vscode.window.activeTextEditor;
      const notebookEditor = vscode.window.activeNotebookEditor;
      const params = {
        command: `${serverId}.printDebugInformation`,
        arguments: [
          {
            textDocument: notebookEditor
              ? { uri: notebookEditor.notebook.uri.toString() }
              : textEditor
                ? { uri: textEditor.document.uri.toString() }
                : undefined,
          },
        ],
      };
      return await lsClient.sendRequest(ExecuteCommandRequest.type, params).then(
        (result) => {
          return result;
        },
        async () => {
          vscode.window.showErrorMessage(
            `Failed to print debug information. Please consider opening an issue at ${ISSUE_TRACKER} with steps to reproduce.`,
          );
          return "";
        },
      );
    }

    get onDidChange(): vscode.Event<vscode.Uri> {
      return this.eventEmitter.event;
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ty-server-debug", contentProvider),
  );

  return async () => {
    contentProvider.eventEmitter.fire(contentProvider.uri);
    const document = await vscode.workspace.openTextDocument(contentProvider.uri);
    const content = document.getText();

    // Show the document only if it has content.
    if (content.length > 0) {
      void (await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true,
      }));
    }
  };
}
