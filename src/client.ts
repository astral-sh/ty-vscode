import {
  type Middleware,
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
import { EnvironmentProvider, getEnvironmentProvider } from "./common/python";

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
  setServerVersion(major: number, minor: number, patch: number): void;
}

export function createTyMiddleware(environmentProvider: EnvironmentProvider | null): TyMiddleware {
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
                              patch: resolved.version.patch,
                              sysVersion: `${resolved.version.major}.${resolved.version.minor}.${resolved.version.patch}`,
                            },
                      environment:
                        resolved.environment == null
                          ? undefined
                          : {
                              folderUri: resolved.environment.environmentPath.toString(),
                              name: resolved.environment.displayName ?? undefined,
                              type: resolved.environment.type,
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
  executable: { uri: string; sysPrefix: string };
  environment?: { folderUri: string; type: string; name: string | undefined };
  version?: { major: number; minor: number; patch: number; sysVersion: string };
};
