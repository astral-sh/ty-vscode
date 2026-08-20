# Contributing

## Development

### Getting Started

- Install [Node.js](https://nodejs.org/).
- Install [`uv`](https://github.com/astral-sh/uv).
- Install development dependencies:

  ```console
  $ uv pip sync --require-hashes ./requirements.txt --target ./bundled/libs
  $ npm ci --ignore-scripts
  ```

- To automatically format the codebase, run:

  ```console
  $ uv run --dev ruff check --fix ./bundled/tool ./build ./scripts
  $ uv run --dev ruff format ./bundled/tool ./build ./scripts
  $ uv tool run --with-requirements ./scripts/release.py ty check --fix ./scripts/release.py
  $ uv run --dev ty check --fix bundled/tool/find_ty_binary_path.py
  $ npm run fmt
  ```

- To run lint and type checks, run:

  ```console
  $ uv run --dev ruff check ./bundled/tool ./build ./scripts
  $ uv run --dev ruff format --check ./bundled/tool ./build ./scripts
  $ uv tool run --with-requirements ./scripts/release.py ty check ./scripts/release.py
  $ uv run --dev ty check bundled/tool/find_ty_binary_path.py
  $ npm run fmt-check
  $ npm run lint
  $ npm run tsc
  ```

To run the extension, navigate to `src/extension.ts` and run (`F5`). You should see the extension output
and the language server log messages in the debug console under "ty" and "ty Language Server" respectively.

### Language server protocol extensions

The ty server's experimental Language Server Protocol extensions are documented in [ty's documentation](https://docs.astral.sh/ty/features/language-server/).

### Using a custom version of ty

- Clone [ty](https://github.com/astral-sh/ty) to, e.g., `/home/ferris/ty`.
- Run `cargo build` in the ty repository.
- Set `ty.path` to `/home/ferris/ty/target/debug/ty` in the VS Code settings.

## Release

- Run `uv run scripts/release.py`.
  (Run `uv run scripts/release.py --help` for information on what this script does,
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
