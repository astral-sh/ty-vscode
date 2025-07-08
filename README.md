# ty extension for Visual Studio Code

[![image](https://img.shields.io/pypi/v/ty/0.0.1a14.svg)](https://pypi.python.org/pypi/ty)
[![image](https://img.shields.io/pypi/l/ty/0.0.1a14.svg)](https://pypi.python.org/pypi/ty)
[![Actions status](https://github.com/astral-sh/ty-vscode/workflows/CI/badge.svg)](https://github.com/astral-sh/ty-vscode/actions)

A Visual Studio Code extension for [ty](https://github.com/astral-sh/ty), an extremely fast
Python type checker and language server, written in Rust.

> **Warning:**
>
> This extension uses the preview version of ty and is not ready for production use.
>
> We're working hard to make ty stable and feature-complete, but until then, expect to encounter bugs,
> missing features, and fatal errors.

The extension ships with `ty==0.0.1a14`.

## Features

Currently, the extension supports the following features:

- Showing diagnostics in the editor
- Hover type information for symbols
- Go to type definition
- Inlay hints for assignment targets
- Completions

> **Note:**
>
> If you want to test the language server features like completions, go to type definition, etc., it's
> recommended to disable the language server from the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (if installed) by adding the
> following [setting](https://code.visualstudio.com/docs/python/settings-reference#_intellisense-engine-settings) to your `settings.json`:
>
> ```json
> {
>   "python.languageServer": "None"
> }
> ```

## Usage

Once installed in Visual Studio Code, ty will automatically execute when you open or edit a
Python or Jupyter Notebook file.

If you don't want to use ty for a specific workspace, [disable this extension](https://code.visualstudio.com/docs/editor/extension-marketplace#_disable-an-extension)
in VS code.

## Untrusted Workspace

The extension supports [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust).
For untrusted workspaces, the extension always uses the bundled ty executable, ignoring the following settings:

- [`ty.importStrategy`](https://github.com/astral-sh/ty/blob/main/docs/reference/editor-settings.md#importstrategy)
- [`ty.interpreter`](https://github.com/astral-sh/ty/blob/main/docs/reference/editor-settings.md#interpreter)
- [`ty.path`](https://github.com/astral-sh/ty/blob/main/docs/reference/editor-settings.md#path)

## Settings

See [settings](https://github.com/astral-sh/ty/blob/main/docs/reference/editor-settings.md) for an enumeration of all supported settings.

## Commands

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| ty: Restart server   | Restart the ty language server               |
| ty: Show client logs | Open the "ty" output channel                 |
| ty: Show server logs | Open the "ty Language Server" output channel |

## Requirements

This extension requires a version of the VSCode Python extension that supports Python 3.8+. ty
itself is compatible with Python 3.8 to 3.13.

## Getting help

See the [troubleshooting guide](./TROUBLESHOOTING.md) to get more information on how to
debug issues with the extension or the language server.

## License

The ty extension is licensed under the MIT license ([LICENSE](LICENSE)).

<div align="center">
  <a target="_blank" href="https://astral.sh" style="background:none">
    <img height="24px" src="https://raw.githubusercontent.com/astral-sh/ty-vscode/main/assets/png/Astral.png">
  </a>
</div>
