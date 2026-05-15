import * as util from "node:util";
import * as vscode from "vscode";

const GROUP_INDENT = "  ";
const MAX_LEVEL_LABEL_LENGTH = "[warning]".length;

type LogLevel = "error" | "warning" | "info" | "debug" | "trace";

function groupIndent(level: LogLevel, depth: number): string {
  if (depth === 0) {
    return "";
  }

  const levelLabelLength = level.length + 2; // E.g. `[warning]`
  const levelPadding = " ".repeat(MAX_LEVEL_LABEL_LENGTH - levelLabelLength);
  return `${levelPadding}${GROUP_INDENT.repeat(depth)}`;
}

class ExtensionLogger {
  /**
   * The output channel used to log messages for the extension.
   */
  readonly channel = vscode.window.createOutputChannel("ty", { log: true });

  private groupDepth = 0;

  /**
   * Whether the extension is running in a CI environment.
   */
  private readonly isCI = process.env.CI === "true";

  /**
   * Logs messages to the console if the extension is running in a CI environment.
   */
  private logForCI(message: string): void {
    if (this.isCI) {
      // eslint-disable-next-line no-console
      console.log(message);
    }
  }

  private format(level: LogLevel, ...messages: unknown[]): string {
    const message = util.format(...messages);
    if (this.groupDepth === 0) {
      return message;
    }

    return indentMessage(groupIndent(level, this.groupDepth), message);
  }

  error(...messages: unknown[]): void {
    const message = this.format("error", ...messages);
    this.logForCI(message);
    this.channel.error(message);
  }

  warn(...messages: unknown[]): void {
    const message = this.format("warning", ...messages);
    this.logForCI(message);
    this.channel.warn(message);
  }

  info(...messages: unknown[]): void {
    const message = this.format("info", ...messages);
    this.logForCI(message);
    this.channel.info(message);
  }

  debug(...messages: unknown[]): void {
    const message = this.format("debug", ...messages);
    this.logForCI(message);
    this.channel.debug(message);
  }

  trace(...messages: unknown[]): void {
    const message = this.format("trace", ...messages);
    this.logForCI(message);
    this.channel.trace(message);
  }

  group(...messages: unknown[]): void {
    this.info(...messages);
    this.groupDepth += 1;
  }

  groupEnd(): void {
    this.groupDepth = Math.max(0, this.groupDepth - 1);
  }
}

function indentMessage(indent: string, message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * The logger used by the extension.
 *
 * This will log the messages to the "ty" output channel, optionally logging them
 * to the console if the extension is running in a CI environment (e.g., GitHub Actions).
 *
 * This should mainly be used for logging messages that are intended for the user.
 */
export const logger = new ExtensionLogger();

/**
 * A VS Code output channel that is lazily created when it is first accessed.
 *
 * This is useful when the messages are only logged when the extension is configured
 * to log them, as it avoids creating an empty output channel.
 *
 * This is currently being used to create the trace output channel for the language server
 * as it is only created when the user enables trace logging.
 */
export class LazyOutputChannel implements vscode.OutputChannel {
  name: string;
  _channel: vscode.OutputChannel | undefined;

  constructor(name: string) {
    this.name = name;
  }

  get channel(): vscode.OutputChannel {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(this.name);
    }
    return this._channel;
  }

  append(value: string): void {
    this.channel.append(value);
  }

  appendLine(value: string): void {
    this.channel.appendLine(value);
  }

  replace(value: string): void {
    this.channel.replace(value);
  }

  clear(): void {
    this._channel?.clear();
  }

  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(column?: any, preserveFocus?: any): void {
    this.channel.show(column, preserveFocus);
  }

  hide(): void {
    this._channel?.hide();
  }

  dispose(): void {
    this._channel?.dispose();
  }
}
