import * as vscode from "vscode";
import { ExecuteCommandRequest, LanguageClient } from "vscode-languageclient/node";
import { logger } from "./logger";
import {
  selectSoleOrganizeImportsAction,
  type OrganizeImportsActionResult,
} from "./organizeImports";

const ISSUE_TRACKER = "https://github.com/astral-sh/ty/issues";
const ORGANIZE_IMPORTS_CODE_ACTION = vscode.CodeActionKind.SourceOrganizeImports.value;
const CODE_ACTION_RETRY_DELAYS_MS = [0, 50, 100, 250, 500, 1000] as const;
const ACTION_VERSION_ATTEMPTS = 3;

export const AUTO_IMPORT_COMPLETION_COMMAND = "ty.organizeImportsAfterAutoImport";

/**
 * Creates the handler for ty's auto-import completion command.
 *
 * The command runs when VS Code accepts an auto-import completion. It silently skips import
 * organization when no active provider supplies an unambiguous organize-imports action.
 */
export function createOrganizeImportsAfterAutoImportHandler(namespace: string) {
  return async (documentUri: unknown): Promise<void> => {
    if (typeof documentUri !== "string") {
      return;
    }

    const uri = vscode.Uri.parse(documentUri);
    const enabled = vscode.workspace
      .getConfiguration(namespace, uri)
      .get<boolean>("organizeImportsOnAutoImport", false);
    if (!enabled) {
      return;
    }

    await organizeImports(uri);
  };
}

async function organizeImports(uri: vscode.Uri): Promise<void> {
  for (let attempt = 0; attempt < ACTION_VERSION_ATTEMPTS; attempt += 1) {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    if (document == null) {
      logger.debug("Skipping import organization because the document is no longer open");
      return;
    }

    const documentVersion = document.version;
    let result: OrganizeImportsActionResult<vscode.CodeAction | vscode.Command>;
    try {
      result = await getOrganizeImportsAction(document, documentVersion);
    } catch (error) {
      if (isDocumentStale(document, documentVersion)) {
        continue;
      }
      throw error;
    }

    if (isDocumentStale(document, documentVersion)) {
      continue;
    }

    if (result.kind === "unavailable") {
      logger.debug("No organize-imports action is available for", uri.toString());
      return;
    }
    if (result.kind === "ambiguous") {
      logger.debug(
        `Skipping import organization because ${result.count} organize-imports actions are available for`,
        uri.toString(),
      );
      return;
    }

    if ((await applyCodeAction(result.action, document, documentVersion)) !== "stale") {
      return;
    }
  }

  logger.debug("Skipping import organization because the document kept changing", uri.toString());
}

async function getOrganizeImportsAction(
  document: vscode.TextDocument,
  expectedDocumentVersion: number,
): Promise<OrganizeImportsActionResult<vscode.CodeAction | vscode.Command>> {
  // An already active organizer may still be starting or restarting its language server, so its
  // provider can take a short time to appear.
  for (const retryDelay of CODE_ACTION_RETRY_DELAYS_MS) {
    if (retryDelay > 0) {
      await delay(retryDelay);
    }
    if (isDocumentStale(document, expectedDocumentVersion)) {
      return { kind: "unavailable" };
    }

    const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      "vscode.executeCodeActionProvider",
      document.uri,
      new vscode.Range(0, 0, 0, 0),
      ORGANIZE_IMPORTS_CODE_ACTION,
      1,
    );
    const result = selectSoleOrganizeImportsAction(actions ?? []);
    if (result.kind !== "unavailable") {
      return result;
    }
  }

  return { kind: "unavailable" };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function applyCodeAction(
  action: vscode.CodeAction | vscode.Command,
  document: vscode.TextDocument,
  expectedDocumentVersion: number,
): Promise<"done" | "stale"> {
  // VS Code snapshots the document's current version when `applyEdit` is invoked. Keep this check
  // adjacent to that call so an edit computed for an older version is rejected or retried.
  if (isDocumentStale(document, expectedDocumentVersion)) {
    return "stale";
  }

  if (isCommand(action)) {
    await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
    return "done";
  }

  if (action.edit != null && !(await vscode.workspace.applyEdit(action.edit))) {
    return isDocumentStale(document, expectedDocumentVersion) ? "stale" : "done";
  }

  if (action.command != null) {
    await vscode.commands.executeCommand(
      action.command.command,
      ...(action.command.arguments ?? []),
    );
  }

  return "done";
}

function isDocumentStale(document: vscode.TextDocument, expectedVersion: number): boolean {
  return document.isClosed || document.version !== expectedVersion;
}

function isCommand(action: vscode.CodeAction | vscode.Command): action is vscode.Command {
  return typeof action.command === "string";
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
