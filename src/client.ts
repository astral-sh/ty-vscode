import {
  type Middleware,
  ResponseError,
  CancellationToken,
  DidChangeConfigurationNotification,
  type DidChangeConfigurationRegistrationOptions,
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
          const registrationOptions =
            (registration.registerOptions as DidChangeConfigurationRegistrationOptions) ?? null;
          const section = registrationOptions?.section;

          if (Array.isArray(section) && section.includes("ty")) {
            didChangeRegistrations.add(registration.id);
          } else if (section === "ty") {
            didChangeRegistrations.add(registration.id);
          } else if (section == null) {
            didChangeRegistrations.add(registration.id);
          }
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

        return params.items.map((param, index) => {
          const result = response[index];

          if (param.section === "ty") {
            const scopeUri = param.scopeUri ? Uri.parse(param.scopeUri) : undefined;
            const activeEnvironment =
              pythonExtension.environments.getActiveEnvironmentPath(scopeUri);

            return {
              ...result,

              pythonExtension: {
                ...result?.pythonExtension,
                activeEnvironment,
              },
            };
          }
        });
      },
    },
  };

  return middleware;
}
