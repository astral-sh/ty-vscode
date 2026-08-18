const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const methods = ["trace", "debug", "info", "warn", "error"];
const source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/common/logger.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

test("preserves raw stderr, including multiline dumps and interleaved client errors", () => {
  const { channel, calls } = createChannel();
  const lines = [
    ...methods.map((method) => `2026-08-18 14:56:28.140917000 ${method.toUpperCase()} message`),
    "2026-08-18 14:56:28.140917000 DEBUG Before WorkspaceOptions {",
    "    configuration: None,",
    "Request failed",
    "    nested: Some(",
    "        value,",
    "    ),",
    "} after",
    "",
    "an arbitrary\nmultiline message",
  ];
  for (const line of lines) {
    channel.error(line);
  }
  assert.deepEqual(
    calls,
    lines.map((line) => ["appendLine", line]),
  );
});

test("all client logging methods append without filtering or adding a prefix", () => {
  const { channel, calls, vscode } = createChannel();
  assert.equal(vscode.env.logLevel, vscode.LogLevel.Off);
  assert.equal(channel.logLevel, vscode.LogLevel.Trace);
  for (const method of methods) {
    channel[method]("%s: %d", method, 42);
  }
  const error = new Error("client failure");
  error.stack = "Error: client failure\n    at test";
  channel.error(error);
  assert.deepEqual(calls, [
    ...methods.map((method) => ["appendLine", `${method}: 42`]),
    ["appendLine", "Error: client failure\n    at test"],
  ]);
  channel.onDidChangeLogLevel(() => assert.fail("the log level is fixed")).dispose();
});

function createChannel() {
  const channels = new Map();
  const vscode = {
    LogLevel: { Off: 0, Trace: 1 },
    env: { logLevel: 0 },
    window: {
      createOutputChannel(name, options) {
        if (name === "ty") {
          assert.equal(options.log, true);
        } else {
          assert.equal(options, "log");
        }
        const calls = [];
        const channel = {
          name,
          ...Object.fromEntries(
            [...methods, "appendLine"].map((method) => [
              method,
              (...args) => calls.push([method, ...args]),
            ]),
          ),
        };
        channels.set(name, { channel, calls });
        return channel;
      },
    },
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    process: { env: {} },
    require(id) {
      return id === "vscode" ? vscode : require(id);
    },
  });
  const channel = exports.createServerOutputChannel("ty Language Server");
  const { calls } = channels.get("ty Language Server");
  assert.deepEqual(channels.get("ty").calls, []);
  return { channel, calls, vscode };
}
