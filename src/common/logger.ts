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
 * Creates an unformatted server output channel that satisfies the language client's log API.
 *
 * ty already includes timestamps and severity in its logs, so adding VS Code's log formatting
 * would duplicate both and incorrectly label every stderr message as an error. The language
 * client forwards server stderr through `error`; recognize server log levels so client errors
 * and lifecycle messages still go to the client log.
 */
export function createServerOutputChannel(name: string): vscode.LogOutputChannel {
  const channel = vscode.window.createOutputChannel(name, "log");

  return {
    ...channel,
    get logLevel(): vscode.LogLevel {
      return vscode.env.logLevel;
    },
    onDidChangeLogLevel: vscode.env.onDidChangeLogLevel,
    trace: logger.trace.bind(logger),
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error(error: string | Error, ...args: any[]): void {
      const message = util.format(error, ...args);
      // The language client sends both server logs and client errors here. Server logs
      // include a log level and must keep their original format.
      if (/\b(trace|debug|info|warn|error)\b/i.test(message)) {
        channel.appendLine(message);
      } else {
        logger.error(message);
      }
    },
  };
}

/**
 * A VS Code output channel that is lazily created when it is first accessed.
 *
 * This is useful when the messages are only logged when the extension is configured
 * to log them, as it avoids creating an empty output channel.
 *
 * This is currently being used to create the trace output channel for the language server
 * as it is only created when the user enables trace logging.
 *
 * The language client only enables tracing when the channel reports the trace log level. Use
 * the server trace setting for that level so changing the setting does not require a separate
 * editor log-level change.
 */
export class LazyOutputChannel implements vscode.LogOutputChannel {
  name: string;
  _channel: vscode.OutputChannel | undefined;
  readonly onDidChangeLogLevel: vscode.Event<vscode.LogLevel> = (listener, thisArgs, disposables) =>
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration(`${this.serverId}.trace.server`)) {
          listener.call(thisArgs, this.logLevel);
        }
      },
      undefined,
      disposables,
    );

  constructor(
    name: string,
    private readonly serverId: string,
  ) {
    this.name = name;
  }

  get logLevel(): vscode.LogLevel {
    return vscode.workspace.getConfiguration(this.serverId).get("trace.server", "off") === "off"
      ? vscode.LogLevel.Info
      : vscode.LogLevel.Trace;
  }

  get channel(): vscode.OutputChannel {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(this.name, "log");
    }
    return this._channel;
  }

  trace = this.log;
  debug = this.log;
  info = this.log;
  warn = this.log;
  error = this.log;

  private log(message: string | Error, ...args: any[]): void {
    const now = new Date();
    const milliseconds = now.getMilliseconds().toString().padStart(3, "0");
    const time = `${now.toLocaleTimeString("en-GB")}.${milliseconds}`;
    // All protocol messages have the same severity, so do not include it in the output.
    this.channel.appendLine(`[${time}] ${util.format(message, ...args)}`);
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
