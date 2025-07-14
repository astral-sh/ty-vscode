import {
  type Middleware,
  ResponseError,
  CancellationToken,
  DidChangeConfigurationNotification,
} from "vscode-languageclient";
import { Uri } from "vscode";
import type { PythonExtension } from "@vscode/python-extension";

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

              return {
                ...result,

                pythonExtension: {
                  ...result?.pythonExtension,
                  activeEnvironment,
                },
              };
            }
          }),
        );
      },
    },
  };

  return middleware;
}
