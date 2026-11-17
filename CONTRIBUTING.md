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
for the next even minor version and enables GitHub auto-merge. GitHub squash-merges it when the branch protection
requirements are met. The merge listener dispatches [Release](https://github.com/astral-sh/ty-vscode/actions/workflows/release.yml)
with the PR number. Release verifies the merged PR and builds from its squash commit. After the builds finish,
approve `release-gate` to publish.

Before enabling auto-promotion, apply the organization rulesets for `release/auto/*`. They reserve branch creation
for the releases bot and block updates, keeping the prepared commit fixed while GitHub waits to merge. GitHub
can still delete the branch after merge. The Prepare workflow checks for the update restriction before pushing.

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

- If preparation fails before pushing the branch, rerun the failed job in Prepare release.
- If an automated release PR is behind the default branch or preparation fails after pushing
  `release/auto/<version>`, close the PR if it exists and delete that branch before rerunning Prepare release.
- If Prepare reports a conflicting release PR for the same version, resolve that PR before rerunning.
- If the merge listener fails to dispatch Release, rerun it or start Release from your personal GitHub
  account with the merged PR number as `release-pr`.
- If the default branch advances between merge and dispatch, review the intervening changes and start
  Release manually without `release-pr`. Set `version` to the intended extension version and `expected-sha`
  to the default branch commit you reviewed.
- If a build or publish job fails, rerun the failed jobs in the original Release run.
