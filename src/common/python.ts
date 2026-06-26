import { isDeepStrictEqual } from "node:util";
import { type Disposable, type Event, EventEmitter, extensions, Uri } from "vscode";
import { logger } from "./logger";
import {
  PythonExtension as PythonExtensionApi,
  type ResolvedEnvironment,
} from "@vscode/python-extension";
import type { PythonEnvironmentApi, PythonEnvironment } from "@vscode/python-environments";

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
   * Resolves the Python Interpreter, given a path to a Python executable or virtual environment folder.
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

const pythonExtension = lazyInit(PythonExtension.tryActivate);

/**
 * Activates the Python Extension, if available.
 * @returns Cached Python Extension instance or the newly activated instance.
 */
async function getPythonExtension(): Promise<PythonExtension | null> {
  return pythonExtension.get();
}

class PythonEnvironmentExtension implements EnvironmentProvider {
  #extension: PythonEnvironmentApi;
  /**
   * The Python Environments extension is extremelly trigger happy when it
   * comes to firing environment changed events. Firing `onDidChangeActivePythonEnvironmentEvent` has
   * a significant cost because we use it to restart the server, if the root environment changed.
   *
   * To avoid unnecessary restarts, we keep track of the active environments per scope
   * and only fire the event when the active environment (reduced to the properties we care about)
   * changed. The event always triggers for environments that we've never seen before.
   */
  #activeEnvironments = createActiveEnvironmentCache();

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

    // The Python Environments extension can return no API when
    // `python.useEnvironmentsExtension` is false.
    if (extension.exports == null) {
      logger.info(
        "The Python Environments extension is disabled by 'python.useEnvironmentsExtension'.",
      );
      return null;
    }

    return new PythonEnvironmentExtension(extension.exports as PythonEnvironmentApi);
  }

  async initialize(disposables: Disposable[]): Promise<void> {
    logger.info("Using Python Environments extension for Python environment detection");

    // Server startup resolves the project environment. Avoid a global lookup here because it can
    // trigger full environment discovery and block extension activation.

    disposables.push(
      this.#extension.onDidChangeEnvironment((e) => {
        logger.debug(`Python Environments didChangeEnvironment: ${JSON.stringify(e, null, 2)}`);

        const uri = e.uri;
        const environment = e.new == null ? null : this.toEnvironmentDetails(e.new);
        const previousEnvironment = e.old == null ? null : this.toEnvironmentDetails(e.old);

        if (areEnvironmentsEqual(previousEnvironment, environment)) {
          this.#activeEnvironments.remember(uri, environment);
          logger.debug(
            `Ignoring Python Environments change event because the active environment is unchanged for '${uri ?? "workspace"}'.`,
          );
          return;
        }

        if (!this.#activeEnvironments.record(uri, environment)) {
          logger.debug(
            `Ignoring Python Environments change event because the active environment is unchanged for '${uri ?? "workspace"}'.`,
          );
          return;
        }

        onDidChangeActivePythonEnvironmentEvent.fire({
          path: environment?.executable ?? undefined,
          uri,
        });
      }),
    );
  }

  async resolveInterpreter(path: string): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.resolveEnvironment(Uri.file(path));

    if (environment == null) {
      return null;
    }

    return this.toEnvironmentDetails(environment);
  }

  async getActiveEnvironment(uri?: Uri): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.#extension.getEnvironment(uri);
    const details = environment == null ? null : this.toEnvironmentDetails(environment);

    this.#activeEnvironments.remember(uri, details);

    if (details != null) {
      logger.debug(`Resolved Python environment: '${details.sysPrefix}'`);
    }

    return details;
  }

  private toEnvironmentDetails(environment: PythonEnvironment): PythonEnvironmentDetails | null {
    if (environment.error) {
      logger.warn(
        `Ignoring environment '${environment.environmentPath}' with errors: ${environment.error}`,
      );
      return null;
    }

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

function createActiveEnvironmentCache() {
  const environments = new Map<string | symbol, PythonEnvironmentDetails | null>();
  const WORKSPACE_KEY = Symbol("workspace");

  function scopeKey(uri: Uri | undefined): string | symbol {
    return uri?.toString() ?? WORKSPACE_KEY;
  }

  return {
    remember(uri: Uri | undefined, environment: PythonEnvironmentDetails | null): void {
      environments.set(scopeKey(uri), environment);
    },

    /**
     * Records the active environment for the given scope and returns wheter it changed compared to the previously recorded environment.
     */
    record(uri: Uri | undefined, environment: PythonEnvironmentDetails | null): boolean {
      const cacheKey = scopeKey(uri);
      const cachedEnvironment = environments.get(cacheKey);
      const unchanged = isDeepStrictEqual(cachedEnvironment, environment);

      environments.set(cacheKey, environment);

      return !unchanged;
    },
  };
}

/**
 * Deep equality check for two Python environments (thanks JS for having no built-in deep equality check).
 */
function areEnvironmentsEqual(
  left: PythonEnvironmentDetails | null,
  right: PythonEnvironmentDetails | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

const pythonEnvironmentExtension = lazyInit(PythonEnvironmentExtension.tryActivate);

async function getPythonEnvironmentExtension(): Promise<PythonEnvironmentExtension | null> {
  return pythonEnvironmentExtension.get();
}

export interface PythonEnvironmentDetails {
  /** The path to the Python executable. */
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

  /** The Python version */
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
  logger.warn(`Selected Python path: '${resolved.executable}'`);
  logger.warn("Supported versions are 3.8 and above.");
  return false;
}

const unavailable = Symbol("unavailable");
/**
 * The value gets initialized when calling `get` the first time.
 *
 * The factory can indicate that creating the value failed by returning `null`.
 * In that case, the `get` method will return `null` on subsequent calls without calling the factory again.
 * This prevents repeatedly trying to create a value that cannot be created (e.g., because a required extension is not available).
 */
function lazyInit<T>(factory: () => Promise<T | null>): { get(): Promise<T | null> } {
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
