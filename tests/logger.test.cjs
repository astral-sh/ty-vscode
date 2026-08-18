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

test("routes ty records to their native severity without the server timestamp", () => {
  const { channel, calls } = createChannel();
  const timestamp = "2026-08-18 14:56:28.140917000";
  for (const method of methods) {
    channel.error(`${timestamp} ${method.toUpperCase().padStart(5)} message`);
  }
  assert.deepEqual(
    calls,
    methods.map((method) => [method, "message"]),
  );
});

test("keeps nested Rust debug lines and the final delimiter at the opening severity", () => {
  const { channel, calls } = createChannel();
  channel.error("2026-08-18 14:56:28.140917000 DEBUG WorkspaceOptions {");
  channel.error("    completions: Some(");
  channel.error("\tCompletionOptions {");
  channel.error("        auto_import: true,");
  channel.error("    },");
  channel.error("    ),");
  channel.error("}");
  channel.error("    unrelated client error");
  assert.deepEqual(calls, [
    ["debug", "WorkspaceOptions {"],
    ["debug", "    completions: Some("],
    ["debug", "\tCompletionOptions {"],
    ["debug", "        auto_import: true,"],
    ["debug", "    },"],
    ["debug", "    ),"],
    ["debug", "}"],
    ["error", "    unrelated client error"],
  ]);
});

test("recognizes the other opening and closing delimiters", () => {
  for (const [opening, closing] of [
    ["Client info: Some(", ")"],
    ["Unknown options: [", "]"],
    ["Nested: ([ \t", "]), \t"],
  ]) {
    const { channel, calls } = createChannel();
    channel.error(`2026-08-18 14:56:28.140917000  WARN ${opening}`);
    channel.error(closing);
    channel.error("    no longer a continuation");
    assert.deepEqual(calls, [
      ["warn", opening],
      ["warn", closing],
      ["error", "    no longer a continuation"],
    ]);
  }
});

test("a new record or an unrelated client error ends the preceding dump", () => {
  const failure = new Error("client failure");
  for (const [interruption, expected] of [
    [["Request failed"], ["error", "Request failed"]],
    [[failure], ["error", failure]],
    [
      ["    client error %s", "details"],
      ["error", "    client error %s", "details"],
    ],
    [["2026-08-18 14:56:28.140917000  INFO Ready"], ["info", "Ready"]],
  ]) {
    const { channel, calls } = createChannel();
    channel.error("2026-08-18 14:56:28.140917000 DEBUG WorkspaceOptions {");
    channel.error(...interruption);
    channel.error("    no longer a continuation");
    assert.deepEqual(calls, [
      ["debug", "WorkspaceOptions {"],
      expected,
      ["error", "    no longer a continuation"],
    ]);
  }
});

test("leaves ordinary client logging and native channel behavior unchanged", () => {
  const { channel, native, calls } = createChannel();
  for (const method of methods.slice(0, -1)) {
    assert.equal(channel[method], native[method]);
    channel[method]("message", 42);
  }
  const error = new Error("client failure");
  channel.error(error, "details");
  channel.error("Request failed: internal error");
  channel.error("    ClientInfo {");
  assert.deepEqual(calls, [
    ...methods.slice(0, -1).map((method) => [method, "message", 42]),
    ["error", error, "details"],
    ["error", "Request failed: internal error"],
    ["error", "    ClientInfo {"],
  ]);
  native.logLevel = 5;
  assert.equal(channel.logLevel, 5);
  assert.equal(channel.onDidChangeLogLevel, native.onDidChangeLogLevel);
});

function createChannel() {
  const channels = new Map();
  const vscode = {
    window: {
      createOutputChannel(name, options) {
        assert.equal(options.log, true);
        const calls = [];
        const channel = {
          name,
          logLevel: 3,
          onDidChangeLogLevel() {},
          ...Object.fromEntries(
            methods.map((method) => [method, (...args) => calls.push([method, ...args])]),
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
  const { channel: native, calls } = channels.get("ty Language Server");
  assert.deepEqual(channels.get("ty").calls, []);
  return { channel, native, calls };
}
