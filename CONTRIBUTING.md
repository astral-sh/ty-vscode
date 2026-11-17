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
on the default branch with `auto-promote=true`. Only the upstream releases bot can start an auto-promotion.
Prepare skips older upstream versions and versions already pinned in a stable extension. Otherwise it opens a PR
for the next even minor version. Once the required checks pass on the prepared commit, the bot squash-merges it.
A separate job in the `release-dispatch` environment starts [Release](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yml)
with the squash commit SHA. After the builds finish, approve `release-gate` to publish.

### Manual releases

Run Prepare release on the default branch with `auto-promote` off (the default). With no inputs, it bundles
the latest ty on PyPI and sets the extension version to `<UTC year>.<current minor + 2>.0`.
To prepare a specific upstream release, replace `<upstream-version>` with its version number.

```sh
gh workflow run release-prepare.yml --repo astral-sh/ty-vscode -f ty-version='<upstream-version>'
```

For an extension-only release or a pre-release, set the `version` input when preparing the PR.
Review and merge the PR. Start Release on the default branch from your personal GitHub account.
The extension version defaults to the one in `package.json`. Approve `release-gate` after the builds finish.

Odd minor versions are pre-releases and retain timestamped nightly build IDs; even minor versions are stable releases.

The requested extension version must be greater than the checked-in version when preparing a release, and greater than all existing release tags when preparing or publishing a release.

After both publications succeed, the workflow creates the `<version>` tag and GitHub release, automatically marking odd
minor versions as pre-releases. Review and curate the generated GitHub release notes as needed.

It may take a few minutes after the workflow completes for the extension to be available.

### Retrying a release

- If preparation fails before merge, a maintainer can rerun the failed job in Prepare release.
- If dispatch fails after merge, rerun **Dispatch release** in the original Prepare release run to reuse the squash SHA.
- If Release reports that the default branch advanced before dispatch, rerunning it checks the same SHA again.
  Review the intervening commits, then start a new Release with the intended `version` and the reviewed commit as `expected-sha`.
- If a build or publish job fails, rerun the failed jobs in the original Release run.
