import { type Disposable, type Event, EventEmitter, extensions } from "vscode";
import { logger } from "./logger";
import { PythonExtension, Resource, type ResolvedEnvironment } from "@vscode/python-extension";
import { PythonEnvironmentApi, PythonEnvironments } from "@vscode/python-environments";

export interface IInterpreterDetails {
  path?: string[];
  resource?: Resource;
}

export class EnvironmentApi {
  constructor(private extension: PythonExtension | PythonEnvironmentApi) {}
}

export async function getEnvironmentApi(): Promise<EnvironmentApi | undefined> {
  const environmentApi = await getEnvironmentExtensionAPI();

  if (environmentApi != null) {
    return new EnvironmentApi(environmentApi);
  }

  const pythonExtensionApi = await getPythonExtensionAPI();

  return new EnvironmentApi(pythonExtensionApi);
}

const onDidChangePythonInterpreterEvent = new EventEmitter<IInterpreterDetails>();
export const onDidChangePythonInterpreter: Event<IInterpreterDetails> =
  onDidChangePythonInterpreterEvent.event;

let _pythonApi: PythonExtension | undefined;
export async function getPythonExtensionAPI(): Promise<PythonExtension> {
  const api = _pythonApi || (await PythonExtension.api());

  _pythonApi = api;
  return api;
}

let _pythonEnvApi: PythonEnvironmentApi | undefined;
async function getEnvironmentExtensionAPI(): Promise<PythonEnvironmentApi | null> {
  if (_pythonEnvApi) {
    return _pythonEnvApi;
  }

  try {
    const extension = extensions.getExtension("ms-python.vscode-python-envs");

    if (extension == null) {
      logger.info("The Python Environment extensions is not installed or is disabled.");
      return null;
    }

    _pythonEnvApi = await PythonEnvironments.api();
    logger.info("Successfully activated the Python Environment extension.");
  } catch {
    // Python environments extension isn't available.
    logger.warn("Failed to activate the Python Environment extension.");
    return null;
  }

  return _pythonEnvApi;
}

export async function initializePython(disposables: Disposable[]): Promise<void> {
  try {
    // Prefer the python environment extension if available.
    const environmentApi = await getEnvironmentExtensionAPI();

    if (environmentApi != null) {
      environmentApi.onDidChangeEnvironment((e) => {
        onDidChangePythonInterpreterEvent.fire({
          path: e.new ? [e.new.execInfo.run.executable] : undefined,
          resource: e.uri,
        });
      });

      logger.debug("Waiting for interpreter from python environments extension.");
      onDidChangePythonInterpreterEvent.fire(await getInterpreterDetails());
      return;
    }

    const api = await getPythonExtensionAPI();

    disposables.push(
      api.environments.onDidChangeActiveEnvironmentPath((e) => {
        onDidChangePythonInterpreterEvent.fire({
          path: [e.path],
          resource: e.resource,
        });
      }),
    );

    logger.info("Waiting for interpreter from python extension.");
    onDidChangePythonInterpreterEvent.fire(await getInterpreterDetails());
  } catch (error) {
    logger.error("Error initializing python: ", error);
  }
}

export async function resolveInterpreter(
  interpreter: string[],
): Promise<ResolvedEnvironment | undefined> {
  const api = await getPythonExtensionAPI();
  return api.environments.resolveEnvironment(interpreter[0]);
}

export async function getInterpreterDetails(resource?: Resource): Promise<IInterpreterDetails> {
  const api = await getPythonExtensionAPI();
  const environment = await api.environments.resolveEnvironment(
    api.environments.getActiveEnvironmentPath(resource),
  );
  if (environment?.executable.uri) {
    return { path: [environment?.executable.uri.fsPath], resource };
  }
  return { path: undefined, resource };
}

export function checkVersion(resolved: ResolvedEnvironment): boolean {
  const version = resolved.version;
  if (version?.major === 3 && version?.minor >= 8) {
    return true;
  }
  logger.warn(`Python version ${version?.major}.${version?.minor} is not supported.`);
  logger.warn(`Selected python path: ${resolved.executable.uri?.fsPath}`);
  logger.warn("Supported versions are 3.8 and above.");
  return false;
}
