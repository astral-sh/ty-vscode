# ty extension for Visual Studio Code

[![image](https://img.shields.io/pypi/v/ty/0.0.17.svg)](https://pypi.python.org/pypi/ty)
[![image](https://img.shields.io/pypi/l/ty/0.0.17.svg)](https://pypi.python.org/pypi/ty)
[![Actions status](https://github.com/astral-sh/ty-vscode/workflows/CI/badge.svg)](https://github.com/astral-sh/ty-vscode/actions)

A Visual Studio Code extension for [ty](https://github.com/astral-sh/ty), an extremely fast
Python type checker and language server, written in Rust.

The extension ships with `ty==0.0.17`.

## Installation

Install this extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=astral-sh.ty).

## Features

Currently, the extension supports the following features:

- [File and workspace level diagnostics](https://code.visualstudio.com/docs/editing/editingevolved#_errors-warnings)
- Hover type information for symbols
- [Go to definition](https://code.visualstudio.com/docs/editing/editingevolved#_go-to-definition)
- Go to declaration
- [Go to type definition](https://code.visualstudio.com/docs/editing/editingevolved#_go-to-type-definition)
- [Go to symbol](https://code.visualstudio.com/docs/editing/editingevolved#_go-to-symbol)
- [Open symbol by name](https://code.visualstudio.com/docs/editing/editingevolved#_open-symbol-by-name)
- Find references
- [Inlay hints](https://code.visualstudio.com/docs/editing/editingevolved#_inlay-hints)
- [Completions](https://code.visualstudio.com/docs/editing/intellisense)
- Signature help
- Highlight references of symbols
- [Semantic highlighting](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)
- Symbol renaming

## Usage

Once installed in Visual Studio Code, ty will automatically execute when you open or edit a
Python or Jupyter Notebook file.

The extension automatically disables the language server from the [Python
extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python)
to avoid running two Python language servers. This is done by setting
[`python.languageServer`](https://code.visualstudio.com/docs/python/settings-reference#_intellisense-engine-settings) to `"None"` as a default configuration.

If you prefer to use ty only for type checking and want to use another language
server for capabilities like hover, auto-completions, etc., you can override
this by explicitly setting [`python.languageServer`](https://code.visualstudio.com/docs/python/settings-reference#_intellisense-engine-settings) and
[`ty.disableLanguageServices`](https://docs.astral.sh/ty/reference/editor-settings/#disablelanguageservices)
in your [`settings.json`](https://code.visualstudio.com/docs/configure/settings#_settings-json-file):

```jsonc
{
  "python.languageServer": "Pylance",
  "ty.disableLanguageServices": true,
}
```

If you don't want to use ty for a specific workspace, [disable this extension](https://code.visualstudio.com/docs/editor/extension-marketplace#_disable-an-extension)
in VS code.

## Untrusted Workspace

The extension supports [untrusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust).
For untrusted workspaces, the extension always uses the bundled ty executable, ignoring the following settings:

- [`ty.importStrategy`](https://docs.astral.sh/ty/reference/editor-settings#importstrategy)
- [`ty.interpreter`](https://docs.astral.sh/ty/reference/editor-settings#interpreter)
- [`ty.path`](https://docs.astral.sh/ty/reference/editor-settings#path)

## Settings

See the ty [editor settings reference](https://docs.astral.sh/ty/reference/editor-settings/) for an enumeration of all supported settings.

## Commands

| Command                    | Description                                  |
| -------------------------- | -------------------------------------------- |
| ty: Restart server         | Restart the ty language server               |
| ty: Show client logs       | Open the "ty" output channel                 |
| ty: Show server logs       | Open the "ty Language Server" output channel |
| ty: Open debug information | Opens a window with debug information        |

## Requirements

This extension requires a version of the VSCode Python extension that supports Python 3.8+. ty
itself is compatible with Python 3.8 to 3.14.

## Getting help

See the [troubleshooting guide](./TROUBLESHOOTING.md) to get more information on how to
debug issues with the extension or the language server.

## Publisher

This extension is published under the [`astral-sh`](https://marketplace.visualstudio.com/publishers/astral-sh) account, which differs from
our [Ruff extension](https://marketplace.visualstudio.com/publishers/charliermarsh) that uses
the "charliermarsh" publisher. Both extensions are official products from Astral.

## License

The ty extension is licensed under the MIT license ([LICENSE](LICENSE)).

<div align="center">
  <a target="_blank" href="https://astral.sh" style="background:none">
    <img height="24px" src="https://raw.githubusercontent.com/astral-sh/ty-vscode/main/assets/png/Astral.png">
  </a>
</div>
