import {
  type BaseLanguageClient,
  type Middleware,
  type ClientCapabilities,
  type FeatureState,
  type StaticFeature,
  DocumentDiagnosticReportKind as ProtocolDocumentDiagnosticReportKind,
  type WorkspaceDiagnosticReport as ProtocolWorkspaceDiagnosticReport,
  type WorkspaceDocumentDiagnosticReport as ProtocolWorkspaceDocumentDiagnosticReport,
  WorkspaceDiagnosticRequest,
  vsdiag,
  ResponseError,
  CancellationToken,
  DidChangeConfigurationNotification,
} from "vscode-languageclient";
import { Uri, workspace } from "vscode";
import {
  resolveVariables,
  type InitializationOptions,
  type ExtensionSettings,
  checkSettingSupported,
} from "./common/settings";
import { EnvironmentProvider } from "./common/python";
import { FullDiagnosticProvider } from "./common/diagnostics";

// Keys that are handled by the extension and should not be sent to the server
type ExtensionOnlyKeys = keyof InitializationOptions | keyof ExtensionSettings | "trace";

const EXTENSION_ONLY_KEYS = {
  // InitializationOptions
  logLevel: true,
  logFile: true,

  // ExtensionSettings
  cwd: true,
  path: true,
  interpreter: true,
  importStrategy: true,

  // Client-handled settings
  trace: true,
} as const satisfies Record<ExtensionOnlyKeys, true>;

function isExtensionOnlyKey(key: string): key is ExtensionOnlyKeys {
  return key in EXTENSION_ONLY_KEYS;
}

export class FullDiagnosticOutputFeature implements StaticFeature {
  fillClientCapabilities(capabilities: ClientCapabilities): void {
    capabilities.experimental = {
      ...capabilities.experimental,
      // Protocol: https://docs.astral.sh/ty/features/language-server/#full-diagnostic-output
      fullDiagnosticOutput: true,
    };
  }

  initialize(): void {}

  getState(): FeatureState {
    return { kind: "static" };
  }

  clear(): void {}
}

export interface TyMiddleware extends Middleware {
  isDidChangeConfigurationRegistered(): boolean;
  setServerVersion(major: number, minor: number, patch: number): void;
}

async function convertWorkspaceDiagnosticReport(
  client: BaseLanguageClient,
  fullDiagnosticProvider: FullDiagnosticProvider,
  report: ProtocolWorkspaceDocumentDiagnosticReport,
  token: CancellationToken,
): Promise<{
  report: vsdiag.WorkspaceDocumentDiagnosticReport;
  activate?: () => void;
}> {
  const uri = client.protocol2CodeConverter.asUri(report.uri);
  if (report.kind === ProtocolDocumentDiagnosticReportKind.Full) {
    const items = await client.protocol2CodeConverter.asDiagnostics(report.items, token);
    return {
      report: {
        kind: vsdiag.DocumentDiagnosticReportKind.full,
        uri,
        resultId: report.resultId,
        version: report.version,
        items,
      },
      activate: fullDiagnosticProvider.prepareWorkspaceDiagnostics(uri, items),
    };
  }

  return {
    report: {
      kind: vsdiag.DocumentDiagnosticReportKind.unChanged,
      uri,
      resultId: report.resultId,
      version: report.version,
    },
  };
}

async function reportWorkspaceDiagnostics(
  client: BaseLanguageClient,
  fullDiagnosticProvider: FullDiagnosticProvider,
  report: ProtocolWorkspaceDiagnosticReport,
  token: CancellationToken,
  resultReporter: vsdiag.ResultReporter,
  isRequestActive: () => boolean,
): Promise<void> {
  const items: vsdiag.WorkspaceDocumentDiagnosticReport[] = [];
  const activations: (() => void)[] = [];

  for (const item of report.items) {
    if (!isRequestActive()) {
      return;
    }

    try {
      const converted = await convertWorkspaceDiagnosticReport(
        client,
        fullDiagnosticProvider,
        item,
        token,
      );
      items.push(converted.report);
      if (converted.activate != null) {
        activations.push(converted.activate);
      }
    } catch (error) {
      if (!isRequestActive()) {
        return;
      }
      client.error("Converting workspace diagnostics failed.", error);
    }
  }

  if (!isRequestActive()) {
    return;
  }

  for (const activate of activations) {
    activate();
  }
  resultReporter({ items });
}

export function createTyMiddleware(
  environmentProvider: EnvironmentProvider | null,
  fullDiagnosticProvider: FullDiagnosticProvider,
  getClient: () => BaseLanguageClient | undefined,
): TyMiddleware {
  const didChangeRegistrations = new Set<string>();
  let serverVersion: null | { major: number; minor: number; patch: number } = null;
  let nextWorkspaceDiagnosticRequestId = 0;
  let activeWorkspaceDiagnosticRequestId: number | undefined;

  const middleware: TyMiddleware = {
    isDidChangeConfigurationRegistered() {
      return didChangeRegistrations.size > 0;
    },

    setServerVersion(major: number, minor: number, patch: number) {
      serverVersion = { major, minor, patch };
    },

    async handleRegisterCapability(params, next) {
      await next(params, CancellationToken.None);

      for (const registration of params.registrations) {
        if (registration.method === DidChangeConfigurationNotification.method) {
          didChangeRegistrations.add(registration.id);
        }
      }
    },

    async handleUnregisterCapability(params, next) {
      await next(params, CancellationToken.None);

      for (const registration of params.unregisterations) {
        if (registration.method === DidChangeConfigurationNotification.method) {
          didChangeRegistrations.delete(registration.id);
        }
      }
    },

    async handleDiagnostics(uri, diagnostics, next) {
      fullDiagnosticProvider.updateDiagnostics(uri, diagnostics);
      return next(uri, diagnostics);
    },

    async provideDiagnostics(document, previousResultId, token, next) {
      const report = await next(document, previousResultId, token);
      if (report?.kind === vsdiag.DocumentDiagnosticReportKind.full) {
        const uri = document instanceof Uri ? document : document.uri;
        fullDiagnosticProvider.prepareDocumentDiagnostics(uri, report.items)();
      }
      return report;
    },

    async provideWorkspaceDiagnostics(resultIds, token, resultReporter, next) {
      const client = getClient();
      if (client == null) {
        return next(resultIds, token, resultReporter);
      }
      if (!client.isRunning()) {
        return { items: [] };
      }

      // vscode-languageclient 9 closes over its original reporter in `next`, so replacing the
      // reporter cannot decorate workspace diagnostics before its precedence check. Send the
      // request here and pass the converted reports through the original reporter instead.
      const requestId = nextWorkspaceDiagnosticRequestId;
      nextWorkspaceDiagnosticRequestId += 1;
      activeWorkspaceDiagnosticRequestId = requestId;
      const partialResultToken = `ty-workspace-diagnostics-${requestId.toString()}`;
      const isRequestActive = () =>
        activeWorkspaceDiagnosticRequestId === requestId && !token.isCancellationRequested;
      const deactivateRequest = () => {
        if (activeWorkspaceDiagnosticRequestId === requestId) {
          activeWorkspaceDiagnosticRequestId = undefined;
        }
      };
      let progressQueue = Promise.resolve();
      const progressDisposable = client.onProgress(
        WorkspaceDiagnosticRequest.partialResult,
        partialResultToken,
        (partialResult) => {
          progressQueue = progressQueue.then(() =>
            reportWorkspaceDiagnostics(
              client,
              fullDiagnosticProvider,
              partialResult,
              token,
              resultReporter,
              isRequestActive,
            ),
          );
        },
      );

      try {
        const result = await client.sendRequest(
          WorkspaceDiagnosticRequest.type,
          {
            identifier: "ty",
            previousResultIds: resultIds.map(({ uri, value }) => ({
              uri: client.code2ProtocolConverter.asUri(uri),
              value,
            })),
            partialResultToken,
          },
          token,
        );
        await progressQueue;

        await reportWorkspaceDiagnostics(
          client,
          fullDiagnosticProvider,
          result,
          token,
          resultReporter,
          isRequestActive,
        );
        return { items: [] };
      } catch (error) {
        deactivateRequest();
        return client.handleFailedRequest(WorkspaceDiagnosticRequest.type, token, error, {
          items: [],
        });
      } finally {
        deactivateRequest();
        progressDisposable.dispose();
      }
    },

    workspace: {
      /**
       * Enriches the configuration response with the active Python environment
       * as reported by the Python extension (respecting the scope URI).
       * The implementation only checks for the "ty" section in the
       * configuration response but not specifically for `ty.pythonExtension.activeEnvironment`.
       */
      async configuration(params, token, next) {
        const response = await next(params, token);

        if (response instanceof ResponseError) {
          return response;
        }

        return Promise.all(
          params.items.map(async (param, index) => {
            const result = response[index];

            if (param.section === "ty") {
              const scopeUri = param.scopeUri ? Uri.parse(param.scopeUri) : undefined;
              const resolved = await environmentProvider?.getActiveEnvironment(scopeUri);

              const activeEnvironment =
                resolved == null
                  ? null
                  : ({
                      version:
                        resolved.version == null
                          ? undefined
                          : {
                              major: resolved.version.major,
                              minor: resolved.version.minor,
                              patch: resolved.version.patch ?? undefined,
                              sysVersion: resolved.version.sysVersion ?? "0.0.0 (unknown)",
                            },
                      environment:
                        resolved.environment == null
                          ? undefined
                          : {
                              folderUri: resolved.environment.environmentPath.toString(),
                              name: resolved.environment.displayName ?? undefined,
                              type: resolved.environment.type ?? undefined,
                            },
                      executable: {
                        uri:
                          resolved.executable == null
                            ? undefined
                            : Uri.file(resolved.executable).toString(),
                        sysPrefix: resolved.sysPrefix,
                      },
                    } satisfies ServerActiveEnvironmentSchema);

              // Filter out extension-only settings that shouldn't be sent to the server
              const serverSettings = Object.fromEntries(
                Object.entries(result ?? {}).filter(
                  ([key, value]) =>
                    !isExtensionOnlyKey(key) &&
                    (serverVersion == null || checkSettingSupported(key, value, serverVersion)),
                ),
              );

              // Resolve VS Code variables from certain settings
              const workspaceFolder = scopeUri ? workspace.getWorkspaceFolder(scopeUri) : undefined;
              if (typeof serverSettings.configurationFile === "string") {
                serverSettings.configurationFile = resolveVariables(
                  serverSettings.configurationFile,
                  workspaceFolder,
                );
              }

              return {
                ...serverSettings,

                pythonExtension: {
                  ...result?.pythonExtension,
                  activeEnvironment,
                },
              };
            }

            return result;
          }),
        );
      },
    },
  };

  return middleware;
}

type ServerActiveEnvironmentSchema = {
  executable: { uri?: string; sysPrefix: string };
  environment?: { folderUri: string; type?: string; name?: string };
  version?: { major: number; minor: number; patch?: number; sysVersion?: string };
};
