import { type Disposable, type Event, EventEmitter, extensions, Uri } from "vscode";
import { logger } from "./logger";
import { PythonExtension as PythonExtensionApi } from "@vscode/python-extension";
import { PythonEnvironmentApi } from "@vscode/python-environments";

const onDidChangePythonInterpreterEvent = new EventEmitter<OnDidChangePythonInterpreterEventArgs>();
export const onDidChangePythonInterpreter: Event<OnDidChangePythonInterpreterEventArgs> =
  onDidChangePythonInterpreterEvent.event;

export async function getEnvironmentProvider(): Promise<EnvironmentProvider | null> {
  const pythonEnvironmentExtension = await getPythonEnvironmentExtension();

  if (pythonEnvironmentExtension != null) {
    return pythonEnvironmentExtension;
  }

  return getPythonExtension();
}

export interface EnvironmentProvider {
  initialize(disposables: Disposable[]): Promise<void>;

  /**
   * Resolves the Python Interpreter, given a path to a Python executable or virtual environment folder,
   */
  resolveInterpreter(path: string): Promise<PythonEnvironmentDetails | null>;

  /**
   * Resolves the active Python environment (virtual environment, system installation) for
   * a file, folder, or workspace.
   */
  getActiveEnvironment(uri?: Uri): Promise<PythonEnvironmentDetails | null>;
}

let pythonExtension: PythonExtension | null | "unavailable" = null;

/**
 * Activates the Python Extension, if available.
 * @returns Cached Python Extension instance or the newly activated instance.
 */
async function getPythonExtension(): Promise<PythonExtension | null> {
  if (pythonExtension === "unavailable") {
    return null;
  }

  const activated = pythonExtension ?? (await PythonExtension.tryActivate());

  if (activated == null) {
    pythonExtension = "unavailable";
    return null;
  }

  pythonExtension = activated;
  return activated;
}

/**
 * Facade to interact with the Python Extension.
 */
class PythonExtension implements EnvironmentProvider {
  #extension: PythonExtensionApi;

  private constructor(extension: PythonExtensionApi) {
    this.#extension = extension;
  }

  static async tryActivate(): Promise<PythonExtension | null> {
    logger.info("Initializing Python extension");

    let extension;

    try {
      extension = await PythonExtensionApi.api();
    } catch (error) {
      logger.error("Error initializing the Python Extension: ", error);
      return null;
    }

    return new PythonExtension(extension);
  }

  async initialize(disposables: Disposable[]): Promise<void> {
    logger.info("Using Python extension for Python environment detection");
    disposables.push(
      this.#extension.environments.onDidChangeActiveEnvironmentPath((e) => {
        onDidChangePythonInterpreterEvent.fire({
          path: e.path,
          uri: e.resource instanceof Uri ? e.resource : e.resource?.uri,
        });
      }),
    );
  }

  async resolveInterpreter(path: string): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.environments.resolveEnvironment(path);

    if (environment == null) {
      return null;
    }

    const version =
      environment.version == null
        ? null
        : {
            major: environment.version.major,
            minor: environment.version.minor,
            patch: environment.version.micro,
          };

    return {
      executable: environment.executable.uri?.fsPath ?? null,
      sysPrefix: environment.executable.sysPrefix,
      environment:
        environment.environment == null
          ? null
          : {
              environmentPath: environment.environment.folderUri,
              displayName: environment.environment.name ?? null,
              type: environment.environment.type,
            },
      version,
    };
  }

  async getActiveEnvironment(uri: Uri): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.environments.resolveEnvironment(
      this.#extension.environments.getActiveEnvironmentPath(uri),
    );

    if (environment == null) {
      return null;
    }

    const version =
      environment.version != null
        ? {
            major: environment.version.major,
            minor: environment.version.minor,
            patch: environment.version.micro,
          }
        : null;

    return {
      executable: environment.executable.uri?.fsPath ?? null,
      sysPrefix: environment.executable.sysPrefix,
      environment:
        environment.environment == null
          ? null
          : {
              environmentPath: environment.environment.folderUri,
              displayName: environment.environment.name ?? null,
              type: environment.environment.type,
            },
      version,
    };
  }
}

let pythonEnvironmentExtension: PythonEnvironmentExtension | null | "unavailable" = null;

async function getPythonEnvironmentExtension(): Promise<PythonEnvironmentExtension | null> {
  if (pythonEnvironmentExtension === "unavailable") {
    return null;
  }

  const activated = pythonEnvironmentExtension ?? (await PythonEnvironmentExtension.tryActivate());

  if (activated == null) {
    pythonEnvironmentExtension = "unavailable";
    return null;
  }

  pythonEnvironmentExtension = activated;
  return activated;
}

class PythonEnvironmentExtension implements EnvironmentProvider {
  #extension: PythonEnvironmentApi;

  private constructor(extension: PythonEnvironmentApi) {
    this.#extension = extension;
  }

  static async tryActivate(): Promise<PythonEnvironmentExtension | null> {
    const extension = extensions.getExtension("ms-python.vscode-python-envs");

    if (extension == null) {
      logger.info("The Python Environment extensions is not installed or is disabled.");
      return null;
    }

    const api = extension.exports as PythonEnvironmentApi;
    if (!extension.isActive) {
      try {
        logger.info("Activating the Python Environment extension");
        await extension.activate();
        logger.info("Successfully activated the Python Environment extension.");
      } catch {
        // Python environments extension isn't available.
        logger.warn("Failed to activate the Python Environment extension.");

        return null;
      }
    }

    return new PythonEnvironmentExtension(api);
  }

  async initialize(disposables: Disposable[]): Promise<void> {
    logger.info("Using Python Environment extension for Python environment detection");

    // Fetch the environment before registering the did change environment handler.
    // It ensures that the Python Environment extension doesn't wire an extra
    // `didChangeEnvironment` event for the workspace root (which results in a server restart...)
    // Very annoying this is.
    await this.getActiveEnvironment(undefined);

    disposables.push(
      this.#extension.onDidChangeEnvironment((e) => {
        // The Python environment extension emits multiple events for the same resource
        // during startup. This alsmost certainly a bug, let's dedupe here.
        if (e.old?.execInfo.run.executable === e.new?.execInfo.run.executable) {
          return;
        }

        // TODO: Not entirely sufficient. Python Environment extension still emits additional events.
        // it's not even sufficient to register the event handler after calling `getActivePythonEnvironment`.
        // It still emits one extra event where

        onDidChangePythonInterpreterEvent.fire({
          path: e.new?.execInfo.run.executable,
          uri: e.uri,
        });
      }),
    );
  }

  async resolveInterpreter(path: string): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.resolveEnvironment(Uri.file(path));

    if (environment == null) {
      return null;
    }

    return {
      executable: environment.execInfo.run.executable,
      sysPrefix: environment.sysPrefix,
      environment: null,
      version: parsePythonVersion(environment.version),
    };
  }

  async getActiveEnvironment(uri?: Uri): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.getEnvironment(uri);

    logger.info(`Resolved environment ${environment}`);

    if (environment == null) {
      return null;
    }

    if (environment.error) {
      logger.warn(
        `Ignoring environment ${environment.environmentPath} with errors: ${environment.error}`,
      );
      return null;
    }

    return {
      executable: environment.execInfo.run.executable,
      sysPrefix: environment.sysPrefix,
      environment: null,
      version: parsePythonVersion(environment.version),
    };
  }
}

// TODO: As it is designed now, it's either one API or the other but never both
// Can we go back to having an interface or a single variable that caches which API to

export type OnDidChangePythonInterpreterEventArgs = {
  path?: string;
  uri?: Uri;
};

export interface PythonEnvironmentDetails {
  /// The path to the Python executable.
  executable: string | null;

  sysPrefix: string;

  /**
   * If the environment is a virtual environment, its display name
   * and path.
   * Always `None` when using the Python Extensions backend.
   * @deprecated
   */
  environment: {
    displayName: string | null;
    environmentPath: Uri;
    type: string;
  } | null;

  /// The Python version
  version: { major: number; minor: number; patch: number } | null;
}

export function checkInterpreterVersion(resolved: PythonEnvironmentDetails): boolean | null {
  const version = resolved.version;

  if (resolved.version == null) {
    return null;
  }

  if (resolved.version.major === 3 && resolved.version.minor >= 8) {
    return true;
  }

  logger.warn(`Python version ${version} is not supported.`);
  logger.warn(`Selected python path: ${resolved.executable}`);
  logger.warn("Supported versions are 3.8 and above.");
  return false;
}

function parsePythonVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  if (version == null) {
    return null;
  }

  const parts = version.split(".");

  if (parts.length < 3) {
    return null;
  }

  const major = parseInt(parts[0]);
  const minor = parseInt(parts[1]);
  const patch = parseInt(parts[2]);

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
  };
}
