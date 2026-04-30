import { type Disposable, type Event, EventEmitter, extensions, Uri } from "vscode";
import { logger } from "./logger";
import {
  PythonExtension as PythonExtensionApi,
  type ResolvedEnvironment,
} from "@vscode/python-extension";
import { PythonEnvironmentApi, PythonEnvironment } from "@vscode/python-environments";

const onDidChangeActivePythonEnvironmentEvent =
  new EventEmitter<OnDidChangeActivePythonEnvironmentEventArgs>();
export type OnDidChangeActivePythonEnvironmentEventArgs = {
  path?: string;
  uri?: Uri;
};
export const onDidChangeActivePythonEnvironment: Event<OnDidChangeActivePythonEnvironmentEventArgs> =
  onDidChangeActivePythonEnvironmentEvent.event;

export async function getEnvironmentProvider(): Promise<EnvironmentProvider | null> {
  return (await getPythonEnvironmentExtension()) ?? (await getPythonExtension());
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
        onDidChangeActivePythonEnvironmentEvent.fire({
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

    return PythonExtension.toEnvironmentDetails(environment);
  }

  async getActiveEnvironment(uri?: Uri): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.environments.resolveEnvironment(
      this.#extension.environments.getActiveEnvironmentPath(uri),
    );

    if (environment == null) {
      return null;
    }

    return PythonExtension.toEnvironmentDetails(environment);
  }

  private static toVersion(
    version: ResolvedEnvironment["version"],
  ): PythonEnvironmentDetails["version"] {
    if (version == null) {
      return null;
    }

    return {
      major: version.major,
      minor: version.minor,
      patch: version.micro,
      sysVersion: version.sysVersion,
    };
  }

  private static toEnvironmentDetails(environment: ResolvedEnvironment): PythonEnvironmentDetails {
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
      version: PythonExtension.toVersion(environment.version),
    };
  }
}

const pythonExtension = cached(PythonExtension.tryActivate);

/**
 * Activates the Python Extension, if available.
 * @returns Cached Python Extension instance or the newly activated instance.
 */
async function getPythonExtension(): Promise<PythonExtension | null> {
  return pythonExtension.get();
}

class PythonEnvironmentExtension implements EnvironmentProvider {
  #extension: PythonEnvironmentApi;

  private constructor(extension: PythonEnvironmentApi) {
    this.#extension = extension;
  }

  static async tryActivate(): Promise<PythonEnvironmentExtension | null> {
    const extension = extensions.getExtension("ms-python.vscode-python-envs");

    if (extension == null) {
      logger.info("The Python Environments extension is not installed or is disabled.");
      return null;
    }

    if (!extension.isActive) {
      try {
        logger.info("Activating the Python Environments extension");
        await extension.activate();
        logger.info("Successfully activated the Python Environments extension.");
      } catch {
        // Python environments extension isn't available.
        logger.warn("Failed to activate the Python Environments extension.");

        return null;
      }
    }

    return new PythonEnvironmentExtension(extension.exports as PythonEnvironmentApi);
  }

  async initialize(disposables: Disposable[]): Promise<void> {
    logger.info("Using Python Environments extension for Python environment detection");

    // Fetch the environment before registering the did change environment handler.
    // It ensures that the Python Environments extension doesn't wire an extra
    // `didChangeEnvironment` event for the workspace root (which results in a server restart...)
    // Very annoying this is.
    let initial = await this.getActiveEnvironment(undefined);

    let lastEnvironmentKey: string | undefined = undefined;

    disposables.push(
      this.#extension.onDidChangeEnvironment((e) => {
        logger.debug(`Python Environments didChangeEnvironment: ${JSON.stringify(e, null, 2)}`);

        const newExecutable = e.new?.execInfo.run.executable;
        const oldExecutable = e.old?.execInfo.run.executable;

        if (oldExecutable != null && oldExecutable === newExecutable) {
          logger.debug(
            `Ignoring Python Environments change event because the executable is unchanged: ${newExecutable}`,
          );
          return;
        }

        // We only care about the executable path, but the Python environment extension
        // may also trigger the event if other properties of the environment changed (e.g. environment id).
        // That's why we dedupe the information here to avoid unnecessary server restarts.
        const environmentKey = `${e.uri?.toString() ?? ""}:${newExecutable}`;

        if (environmentKey === lastEnvironmentKey) {
          logger.info(`Ignoring Python Environments change event: ${environmentKey}`);
          return;
        }

        lastEnvironmentKey = environmentKey;

        // If this is the first event, only emit it if the environment is different from the one we just resolved
        // The Python Environments extension can emit an initial change event for
        // the same environment that we resolved before registering this handler.
        if (initial != null && e.uri == null && initial.executable === newExecutable) {
          logger.info(
            `Ignoring initial Python environment change event for the workspace root: ${newExecutable}`,
          );
          initial = null;
          return;
        }

        initial = null;

        onDidChangeActivePythonEnvironmentEvent.fire({
          path: newExecutable,
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

    if (environment.error != null) {
      logger.warn(
        `Ignoring environment ${environment.environmentPath} with error: ${environment.error}`,
      );
      return null;
    }

    return PythonEnvironmentExtension.toEnvironmentDetails(environment);
  }

  async getActiveEnvironment(uri?: Uri): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.getEnvironment(uri);

    if (environment == null) {
      return null;
    }

    if (environment.error) {
      logger.warn(
        `Ignoring environment ${environment.environmentPath} with errors: ${environment.error}`,
      );
      return null;
    }

    logger.debug(`Resolved Python environment: ${environment.environmentPath}`);

    return PythonEnvironmentExtension.toEnvironmentDetails(environment);
  }

  private static toEnvironmentDetails(environment: PythonEnvironment): PythonEnvironmentDetails {
    return {
      executable: environment.execInfo.run.executable,
      sysPrefix: environment.sysPrefix,
      environment: null,
      version: PythonEnvironmentExtension.parseVersion(environment.version),
    };
  }

  private static parseVersion(version: string): PythonEnvironmentDetails["version"] {
    // Same regex as
    // <https://github.com/microsoft/vscode-python-environments/blob/1db132bb13f2691639650a7d701b3f2ea5f57a23/src/managers/common/utils.ts#L24>
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);

    if (match == null) {
      return null;
    }

    if (match.length !== 4) {
      throw new Error(`Unexpected Python version match length: ${match.length}`);
    }

    const major = parseInt(match[1]);
    const minor = parseInt(match[2]);
    const patch = match[3] == null ? null : parseInt(match[3]);

    return {
      major,
      minor,
      patch,
      sysVersion: null,
    };
  }
}

const pythonEnvironmentExtension = cached(PythonEnvironmentExtension.tryActivate);

async function getPythonEnvironmentExtension(): Promise<PythonEnvironmentExtension | null> {
  return pythonEnvironmentExtension.get();
}

export interface PythonEnvironmentDetails {
  /// The path to the Python executable.
  executable: string | null;

  sysPrefix: string;

  /**
   * If the environment is a virtual environment, its display name
   * and path. `null` if this is a global Python installation.
   *
   * @deprecated Always `null` when using the Python Environments extension.
   */
  environment?: {
    displayName: string | null;
    environmentPath: Uri;
    type: string | null;
  } | null;

  /// The Python version
  version: {
    major: number;
    minor: number;
    patch: number | null;
    /**
     * @deprecated Always `null` when using the Python Environments extension.
     */
    sysVersion: string | null;
  } | null;
}

export function checkInterpreterVersion(resolved: PythonEnvironmentDetails): boolean | null {
  const version = resolved.version;

  if (version == null) {
    return null;
  }

  if (version.major === 3 && version.minor >= 8) {
    return true;
  }

  logger.warn(`Python version ${version.major}.${version.minor} is not supported.`);
  logger.warn(`Selected Python path: ${resolved.executable}`);
  logger.warn("Supported versions are 3.8 and above.");
  return false;
}

const unavailable = Symbol("unavailable");
/**
 * Creates a value exactly once and then caches it.
 *
 * The `factory` is called exactly once. It can return `null`
 * to signal that creating the value failed (e.g. because it isn't available).
 */
function cached<T>(factory: () => Promise<T | null>): { get(): Promise<T | null> } {
  let cache: T | null | typeof unavailable = null;

  return {
    async get() {
      if (cache === unavailable) {
        return null;
      }

      const cached = cache ?? (await factory());

      if (cached == null) {
        cache = unavailable;
        return null;
      }

      cache = cached;
      return cached;
    },
  };
}
