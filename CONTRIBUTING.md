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
  $ npm run fix
  ```

- To run lint and type checks, run:

  ```console
  $ npm run check
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

1. Run the [Prepare release workflow](https://github.com/astral-sh/ty-vscode/actions/workflows/release-prepare.yml)
   from `main` with the exact extension version, without a leading `v`. The workflow runs `scripts/release.py` to update
   the extension version, bundled ty version, README, and lockfiles.
   Optionally specify the bundled ty version; it defaults to the latest version on PyPI.
2. Review and merge the generated release PR.
3. Run the [Release workflow](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yml)
   from `main` with the same extension version.
4. Approve the protected `release-gate` deployment after all platform builds succeed.

Odd minor versions are pre-releases and retain timestamped nightly build IDs; even minor versions are stable releases.

After both publications succeed, the workflow creates the `<version>` tag and GitHub release, automatically marking odd
minor versions as pre-releases. Review and curate the generated GitHub release notes as needed.

It may take a few minutes after the workflow completes for the extension to be available.
