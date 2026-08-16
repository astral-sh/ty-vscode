# Contributing

## Development

### Getting Started

- Install [`uv`](https://github.com/astral-sh/uv).
- Install [`just`](https://github.com/casey/just), or see the `justfile` for corresponding commands.
- Install development dependencies (`just install`).
- To automatically format the codebase, run: `just fmt`.
- To run lint and type checks, run: `just check`.

To run the extension, navigate to `src/extension.ts` and run (`F5`). You should see the extension output
and the language server log messages in the debug console under "ty" and "ty Language Server" respectively.

### Testing optional Python extensions

Build and install the extension in an isolated VS Code profile:

```sh
just install
just check
npm run compile
npm run vsce-package

TY_SMOKE_DIR="$(mktemp -d)"
mkdir "$TY_SMOKE_DIR/project"
code --user-data-dir "$TY_SMOKE_DIR/data" \
  --extensions-dir "$TY_SMOKE_DIR/extensions" \
  --install-extension "$PWD/ty.vsix"
code --user-data-dir "$TY_SMOKE_DIR/data" \
  --extensions-dir "$TY_SMOKE_DIR/extensions" \
  --list-extensions --show-versions
code --new-window --skip-welcome --disable-workspace-trust \
  --user-data-dir "$TY_SMOKE_DIR/data" \
  --extensions-dir "$TY_SMOKE_DIR/extensions" \
  "$TY_SMOKE_DIR/project" "$TY_SMOKE_DIR/project/example.py"
```

Confirm that neither `ms-python.python` nor `ms-python.vscode-python-envs` was installed. Save a
Python file with a type error and check diagnostics, hover, and the selected executable in the
client logs. The recommendation should appear once, and each button should open the matching
extension. Reload the window and confirm that the recommendation does not appear again.

Repeat with `ty.path`, `ty.importStrategy: "useBundled"`, and a ty executable on a controlled `PATH`.
Test with each Python extension, both extensions, and `python.useEnvironmentsExtension: false`.
After changing the selected environment, check that imports and the selected ty executable update.
Without either extension, check a project `.venv` and an explicit `environment.python` setting.

For Restricted Mode, use a fresh profile, omit `--disable-workspace-trust`, and leave the project
untrusted. Confirm that ty uses its bundled executable regardless of the executable settings.
After installing or enabling a Python extension, reload the window and check that it is detected.
Record the extension revision, ty version, selected executable, and relevant logs with the results.

### Language server protocol extensions

The ty server's experimental Language Server Protocol extensions are documented in [ty's documentation](https://docs.astral.sh/ty/features/language-server/).

### Using a custom version of ty

- Clone [ty](https://github.com/astral-sh/ty) to, e.g., `/home/ferris/ty`.
- Run `cargo build` in the ty repository.
- Set `ty.path` to `/home/ferris/ty/target/debug/ty` in the VS Code settings.

## Release

- Run `just release` (or manually `uv run --python=3.8 scripts/release.py`).
  (Run `just release --help` for information on what this script does,
  and its various options.)
- Check the changes the script made, and commit the changes. Note that the version number
  increases in steps of two by default (e.g. `2025.5.0 -> 2025.7.0`). Odd-numbered versions
  are pre-releases, even-numbered versions are stable releases.
- Create a new PR and merge it.
- [Create a new Release](https://github.com/astral-sh/ty-vscode/releases/new):
  - Enter `x.x.x` (where `x.x.x` is the new version) into the _Choose a tag_ selector.
  - Click "Create new tag: ... on publish".
  - Click _Generate release notes_, curate the release notes and publish the release.
  - Be sure to select _Set as a pre-release_ if this is a pre-release (odd minor version).
  - Click _Publish release_.
- The [Release workflow](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yaml)
  should automatically pick up the new release and publish the extension to the VS Code marketplace.
  Note that it may take a few minutes after the workflow completes for the extension to be available.
