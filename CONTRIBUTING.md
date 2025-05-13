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

### Using a custom version of ty

- Clone [ty](https://github.com/astral-sh/ty) to, e.g., `/home/ferris/ty`.
- Run `cargo build` in the ty repository.
- Set `ty.path` to `/home/ferris/ty/target/debug/ty` in the VS Code settings.

## Release

- Run `just release` (or manually `uv run --python=3.7 scripts/release.py`).
  (Run `just release --help` for information on what this script does,
  and its various options.)
- Check the changes the script made, copy-edit the changelog, and commit the changes.
- Create a new PR and merge it.
- [Create a new Release](https://github.com/astral-sh/ty-vscode/releases/new), enter `x.x.x` (where `x.x.x` is the new version) into the _Choose a tag_ selector. Click _Generate release notes_, curate the release notes and publish the release.
- The Release workflow publishes the extension to the VS Code marketplace.
