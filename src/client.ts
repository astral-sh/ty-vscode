import {
  type Middleware,
  ResponseError,
  CancellationToken,
  DidChangeConfigurationNotification,
} from "vscode-languageclient";
import { Uri, workspace } from "vscode";
import type { PythonExtension } from "@vscode/python-extension";
import {
  resolveVariables,
  type InitializationOptions,
  type ExtensionSettings,
} from "./common/settings";

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

interface TyMiddleware extends Middleware {
  isDidChangeConfigurationRegistered(): boolean;
}

export function createTyMiddleware(pythonExtension: PythonExtension): TyMiddleware {
  const didChangeRegistrations = new Set<string>();

  const middleware: TyMiddleware = {
    isDidChangeConfigurationRegistered() {
      return didChangeRegistrations.size > 0;
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
              const path = pythonExtension.environments.getActiveEnvironmentPath(scopeUri);

              const resolved = await pythonExtension.environments.resolveEnvironment(path);

              const activeEnvironment =
                resolved == null
                  ? null
                  : {
                      version:
                        resolved.version == null
                          ? null
                          : {
                              major: resolved.version.major as number,
                              minor: resolved.version.minor as number,
                              patch: resolved.version.micro as number,
                              sysVersion: resolved.version.sysVersion as string,
                            },
                      environment:
                        resolved.environment == null
                          ? null
                          : {
                              folderUri: resolved.environment.folderUri.toString(),
                              uri: resolved.environment.name as string,
                              type: resolved.environment.type as string,
                            },
                      executable: {
                        uri: resolved.executable.uri?.toString(),
                        sysPrefix: resolved.executable.sysPrefix as string,
                      },
                    };

              // Filter out extension-only settings that shouldn't be sent to the server
              const serverSettings = Object.fromEntries(
                Object.entries(result ?? {}).filter(([key]) => !isExtensionOnlyKey(key)),
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
