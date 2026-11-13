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

Stable ty releases start [Prepare release](https://github.com/astral-sh/ty-vscode/actions/workflows/release-prepare.yml)
on the default branch with the upstream version and `auto-promote=true`. It opens a PR for the next even-minor
extension version and watches its required checks for up to 30 minutes. Once they pass, the release bot
squash-merges the prepared commit into the default branch and dispatches
[Release](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yml) with the merge SHA.
Approve `release-gate` after the builds finish. If the default branch advances before Release starts, review
the intervening changes before running Release manually on the new commit.

Only the upstream releases bot can start an auto-promotion. Maintainers can retry that run.
For a manual release, run Prepare release on the default branch with **Auto-promote** off (the default).
With no inputs, the release script uses its default extension version and the latest ty on PyPI.
To prepare a specific upstream version, run

```sh
gh workflow run release-prepare.yml --repo astral-sh/ty-vscode -f ty-version=0.0.103
```

For an extension-only release or a pre-release, set the `version` input when preparing the PR.
Review the PR, merge it, then run Release on the default branch. The extension version
defaults to the one in `package.json`. Approve `release-gate` after the builds finish.

Odd minor versions are pre-releases and retain timestamped nightly build IDs; even minor versions are stable releases.

The requested extension version must be greater than the checked-in version when preparing a release, and greater than all existing release tags when preparing or publishing a release.

After both publications succeed, the workflow creates the `<version>` tag and GitHub release, automatically marking odd
minor versions as pre-releases. Review and curate the generated GitHub release notes as needed.

It may take a few minutes after the workflow completes for the extension to be available.
