import { commands, type Disposable, type Event, EventEmitter, extensions, Uri } from "vscode";
import { logger } from "./logger";
import { PythonEnvironmentApi } from "../vscode-python-environments";
import { ResolvedEnvironment } from "@vscode/python-extension";

export interface IInterpreterDetails {
  path?: string[];
  resource?: Resource;
}

const onDidChangePythonInterpreterEvent = new EventEmitter<IInterpreterDetails>();
export const onDidChangePythonInterpreter: Event<IInterpreterDetails> =
  onDidChangePythonInterpreterEvent.event;

let _api: PythonEnvironmentApi | undefined;
export async function getPythonEnvironmentsAPI(): Promise<PythonEnvironmentApi> {
  if (_api != null) {
    return _api;
  }

  const extension = extensions.getExtension("ms-python.vscode-python-envs");
  if (!extension) {
    throw new Error("Python Environments extension not found.");
  }
  if (extension?.isActive) {
    _api = extension.exports as PythonEnvironmentApi;
    return _api;
  }

  await extension.activate();

  _api = extension.exports as PythonEnvironmentApi;
  return _api;
}

export async function initializePython(disposables: Disposable[]): Promise<void> {
  try {
    const api = await getPythonEnvironmentsAPI();

    disposables.push(
      api.onDidChangeActiveEnvironmentPath((e) => {
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
): Promise<PythonEnvironment | undefined> {
  const api = await getPythonEnvironmentsAPI();
  return api.resolveEnvironment(interpreter[0]);
}

export async function getInterpreterDetails(resource?: Uri): Promise<IInterpreterDetails> {
  const api = await getPythonEnvironmentsAPI();
  const environment = await api.getEnvironment(resource);
  if (environment?.execInfo.run.executable && checkVersion(environment)) {
    return { path: [environment?.execInfo.run.executable], resource };
  }
  return { path: undefined, resource };
}

export function checkVersion(resolved: ResolvedEnvironment): boolean {
  const version = resolved.version;
  if (version?.major === 3 && version?.minor >= 8) {
    return true;
  }
  logger.error(`Python version ${version?.major}.${version?.minor} is not supported.`);
  logger.error(`Selected python path: ${resolved.executable.uri?.fsPath}`);
  logger.error("Supported versions are 3.8 and above.");
  return false;
}
