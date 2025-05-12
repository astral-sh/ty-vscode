# ty extension for Visual Studio Code

[![image](https://img.shields.io/pypi/v/ty/0.0.0a7.svg)](https://pypi.python.org/pypi/ty)
[![image](https://img.shields.io/pypi/l/ty/0.0.0a7.svg)](https://pypi.python.org/pypi/ty)
[![Actions status](https://github.com/astral-sh/ty-vscode/workflows/CI/badge.svg)](https://github.com/astral-sh/ty-vscode/actions)

A Visual Studio Code extension for [ty](https://github.com/astral-sh/ty), an extremely fast
Python type checker and language server, written in Rust.

TODO: Should we change the warning to be specific to the extension?
TODO: Add something about disabling the Pylance server to make sure ty is used for LSP features

> [!WARNING]
>
> ty is in preview and is not ready for production use.
>
> We're working hard to make ty stable and feature-complete, but until then, expect to encounter bugs,
> missing features, and fatal errors.

The extension ships with `ty==0.0.0a7`.

## Usage

Once installed in Visual Studio Code, ty will automatically execute when you open or edit a
Python or Jupyter Notebook file.

If you want to disable ty, you can [disable this extension](https://code.visualstudio.com/docs/editor/extension-marketplace#_disable-an-extension)
per workspace in Visual Studio Code.

## Untrusted Workspace

The extension supports loading in an [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust).
When the workspace is untrusted, the extension will always use the bundled executable of
the `ty` binary regardless of any other settings.

The following settings are not supported in an untrusted workspace:

- [`ty.importStrategy`](#importstrategy)
- [`ty.interpreter`](#interpreter)
- [`ty.path`](#path)

## Settings

### `experimental`

This setting is used to enable or disable experimental features in the language server.

#### `completions.enable`

Whether to enable completions from the language server.

**Default value**: `false`

**Type**: `boolean`

**Example usage**:

```json
{
    "ty.experimental.completions.enable": true
}
```

### `importStrategy`

Strategy for loading the `ty` executable.

- `fromEnvironment` finds ty in the environment, falling back to the bundled version
- `useBundled` uses the version bundled with the extension

**Default value**: `"fromEnvironment"`

**Type**: `"fromEnvironment" | "useBundled"`

**Example usage**:

```json
{
    "ty.importStrategy": "useBundled"
}
```

### `interpreter`

A list of paths to Python interpreters. Even though this is a list, only the first interpreter is
used.

The interpreter path is used to find the `ty` executable when
[`ty.importStrategy`](#importstrategy) is set to `fromEnvironment`.

**Default value**: `[]`

**Type**: `string[]`

**Example usage**:

```json
{
    "ty.interpreter": ["/home/user/.local/bin/python"]
}
```

### `logFile`

Path to the log file to use for the language server.

If not set, logs will be written to stderr.

**Default value**: `null`

**Type**: `string`

**Example usage**:

```json
{
    "ty.logFile": "~/path/to/ty.log"
}
```

### `logLevel`

The log level to use for the language server.

**Default value**: `"info"`

**Type**: `"trace" | "debug" | "info" | "warn" | "error"`

**Example usage**:

```json
{
    "ty.logLevel": "debug"
}
```

### `path`

A list of path to `ty` executables.

The first executable in the list which is exists is used. This setting takes precedence over the
[`ty.importStrategy`](#importstrategy) setting.

**Default value**: `[]`

**Type**: `string[]`

**Example usage**:

```json
{
    "ty.path": ["/home/user/.local/bin/ty"]
}
```

### `trace.server`

The trace level for the language server. Refer to the [LSP
specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#traceValue)
for more information.

**Default value**: `"off"`

**Type**: `"off" | "messages" | "verbose"`

**Example usage**:

```json
{
    "ty.trace.server": "messages"
}
```

## Commands

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| ty: Restart server   | Restart the ty language server               |
| ty: Show client logs | Open the "ty" output channel                 |
| ty: Show server logs | Open the "ty Language Server" output channel |

## Requirements

This extension requires a version of the VSCode Python extension that supports Python 3.7+. ty
itself is compatible with Python 3.7 to 3.13.

## Troubleshooting

If you encounter any issues with the extension or the language server, please refer to the
logs in the corresponding output channel in VS Code. The extension logs are in the "ty"
output channel and the language server logs are in the "ty Language Server" output channel.

To open the output panel, use the `Output: Show Output Channels` command in the command palette
(`Ctrl+Shift+P` or `Cmd+Shift+P`), then select "ty" or "ty Language Server". Alternatively,
you can use the `ty: Show client logs` and `ty: Show server logs` command to open the "ty"
and "ty Language Server" output channel respectively.

The default log level for the extension is `info` which can be changed from the output panel using
the settings icon in the top right corner of the panel.

The default log level for the language server is `info` which can be changed using the `ty.logLevel`
setting in your `settings.json`:

```json
{
  "ty.logLevel": "info"
}
```

The language server logs can be directed to a file by setting the `ty.logFile` setting in
your `settings.json`:

```json
{
  "ty.logFile": "/path/to/ty.log"
}
```

To capture the LSP messages between the editor and the server, set the `ty.trace.server`
setting to either `messages` or `verbose` in your `settings.json`:

```json
{
  "ty.trace.server": "messages"
}
```

This will be visible in the "ty Language Server Trace" output channel. The difference between
`messages` and `verbose` is that `messages` only logs the method name for both the request
and response, while `verbose` also logs the request parameters sent by the client and the
response result sent by the server.

The extension also displays certain information in the status bar. This can be pinned to the status
bar as a permanent item.

<details><summary><b>How to pin the ty status item in VS Code toolbar?</b></summary>
<img
    width="677"
    alt="Instructions to pin 'ty' status item on VS Code editor toolbar"
    src="https://github.com/user-attachments/assets/fae75b6a-ae3f-4933-ad9c-61c6374f435b"
>
</details>

The status bar item displays the status of the language server. It can also be
clicked to open the Ruff output channel.

## License

The ty extension is licensed under the MIT license ([LICENSE](LICENSE)).

<div align="center">
  <a target="_blank" href="https://astral.sh" style="background:none">
    <img height="24px" src="https://raw.githubusercontent.com/astral-sh/ty-vscode/main/assets/png/Astral.png">
  </a>
</div>
