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

A stable ty release starts the [Release workflow](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yml)
on `main` with the released `ty-version` and `publish-extensions=true`. It prepares the next even-minor
extension version, updates the bundled ty pin, README, and lockfiles, then opens a PR. Once CI and
zizmor pass, it squash-merges the tested commit and dispatches the same workflow to publish that
commit. Approve `release-gate` after the platform builds finish. If `main` moved before the
publication run started, review the intervening changes before retrying publication.

To prepare a release manually, run the workflow on `main` with **Publish extensions** unchecked
(the default). With no inputs, the release script increases the minor version by two and bundles
the latest ty from PyPI. To prepare a particular upstream version, pass just its version number:

```sh
gh workflow run release.yml --repo astral-sh/ty-vscode --ref main -f ty-version=0.0.103
```

For an extension-only release or a pre-release, enter the desired extension version when preparing
the PR. Review and merge the PR, then run the workflow again with **Publish extensions** checked
and the bundled ty version blank. The extension version defaults to the one in `package.json`.
Approve `release-gate` after the builds finish.

Odd minor versions are pre-releases and retain timestamped nightly build IDs; even minor versions are stable releases.

The requested extension version must be greater than the checked-in version when preparing a release, and greater than all existing release tags when preparing or publishing a release.

After both publications succeed, the workflow creates the `<version>` tag and GitHub release, automatically marking odd
minor versions as pre-releases. Review and curate the generated GitHub release notes as needed.

It may take a few minutes after the workflow completes for the extension to be available.
