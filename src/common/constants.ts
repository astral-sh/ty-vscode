import * as path from "path";

const folderName = path.basename(__dirname);

/**
 * Path to the root directory of this extension.
 */
export const EXTENSION_ROOT_DIR =
  folderName === "common" ? path.dirname(path.dirname(__dirname)) : path.dirname(__dirname);

/**
 * Name of the `ty` binary based on the current platform.
 */
export const BINARY_NAME = process.platform === "win32" ? "ty.exe" : "ty";

/**
 * Path to the directory containing the bundled Python scripts.
 */
export const BUNDLED_PYTHON_SCRIPTS_DIR = path.join(EXTENSION_ROOT_DIR, "bundled");

/**
 * Path to the `ty` executable that is bundled with the extension.
 */
export const BUNDLED_EXECUTABLE = path.join(BUNDLED_PYTHON_SCRIPTS_DIR, "libs", "bin", BINARY_NAME);

/**
 * The subcommand for the `ty` binary that starts the language server.
 */
export const SERVER_SUBCOMMAND = "server";
