import {
  type Middleware,
  type ClientCapabilities,
  type FeatureState,
  type StaticFeature,
  type DiagnosticRegistrationOptions,
  DocumentDiagnosticRequest,
  vsdiag,
  ResponseError,
  CancellationToken,
  DidChangeConfigurationNotification,
} from "vscode-languageclient";
import { CodeActionTriggerKind, Uri, workspace } from "vscode";
import {
  resolveVariables,
  type InitializationOptions,
  type ExtensionSettings,
  checkSettingSupported,
} from "./common/settings";
import { EnvironmentProvider } from "./common/python";
import { FullDiagnosticProvider } from "./common/diagnostics";
import { getDocumentSelector } from "./common/utilities";

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

/**
 * Advertises support for the `ty.triggerParameterHints` completion command,
 * which the extension executes by triggering VS Code's built-in parameter
 * hints after a callable completion inserts its parentheses.
 */
export class TriggerParameterHintsFeature implements StaticFeature {
  fillClientCapabilities(capabilities: ClientCapabilities): void {
    capabilities.experimental = {
      ...capabilities.experimental,
      commands: {
        commands: ["ty.triggerParameterHints"],
      },
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

export function createTyMiddleware(
  environmentProvider: EnvironmentProvider | null,
  fullDiagnosticProvider: FullDiagnosticProvider,
): TyMiddleware {
  const didChangeRegistrations = new Set<string>();
  let serverVersion: null | { major: number; minor: number; patch: number } = null;

  const middleware: TyMiddleware = {
    isDidChangeConfigurationRegistered() {
      return didChangeRegistrations.size > 0;
    },

    setServerVersion(major: number, minor: number, patch: number) {
      serverVersion = { major, minor, patch };
    },

    async handleRegisterCapability(params, next) {
      for (const registration of params.registrations) {
        if (registration.method !== DocumentDiagnosticRequest.method) {
          continue;
        }

        const options = registration.registerOptions as DiagnosticRegistrationOptions | undefined;
        if (options?.documentSelector != null) {
          continue;
        }

        // Patch the `documentDiagnostic` server capapbility and remove `vscode-notebook-cell` to
        // prevent the VSCode language server client V10 from calling `pullDiagnostic` for
        // cell text-documents.
        //
        // We do this for two reasons:
        //
        // ty versions older than ~Aug 15th 2026 panicked when `pullDiagnostic` was called with
        // a cell text-document. Disabling `pullDiagnostic` for notebook cells ensures backwards
        // compatibility with these older binaries.
        //
        // To workaround the following two upstream issues, by preferring `pushDiagnostic`s for notebook cells:
        // * https://github.com/microsoft/vscode-languageserver-node/issues/1837
        // * and, partially, https://github.com/microsoft/vscode-languageserver-node/issues/1836
        //
        // Once the  upstream issues are fixed, make this registration conditional based on a client/server negogiated
        // capability:
        //
        // * Introduce a new experimental ty-specific `notebookPullDiagnostic` capability. Clients with
        //   a recent enough VS Code language client version set the capability in the initializeRequest
        // * New servers supporting pull diagnostics for cells announce the same `notebookPullDiagnostic` capability
        //   if the client signaled support
        // * The client changes the registration here based on whether the server sent the `notebookPullDiagnostic` capability.
        registration.registerOptions = {
          ...options,
          documentSelector: getDocumentSelector().filter(
            (filter) => filter.scheme !== "vscode-notebook-cell",
          ),
        };
      }

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

    async provideCodeActions(document, range, context, token, next) {
      const actions = await next(document, range, context, token);
      if (context.triggerKind !== CodeActionTriggerKind.Invoke) {
        return actions;
      }

      const fullDiagnosticActions = fullDiagnosticProvider.createCodeActions(context.diagnostics);
      if (fullDiagnosticActions.length === 0) {
        return actions;
      }

      return [...(actions ?? []), ...fullDiagnosticActions];
    },

    provideWorkspaceDiagnostics(resultIds, token, resultReporter, next) {
      return next(resultIds, token, (report) => {
        if (token.isCancellationRequested) {
          return;
        }

        for (const item of report?.items ?? []) {
          if (item.kind === vsdiag.DocumentDiagnosticReportKind.full) {
            fullDiagnosticProvider.prepareWorkspaceDiagnostics(item.uri, item.items)();
          }
        }

        resultReporter(report);
      });
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
