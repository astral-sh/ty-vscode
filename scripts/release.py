"""
Script for automating changes necessary for `ty-vscode` releases.

This script does the following things:
- Bumps the version of this project in `pyproject.toml` and `package.json`
- Bumps the `ty` dependency pin in `pyproject.toml`
- Updates the changelog and README
- Updates the package's lockfiles

Use --validate VERSION to check an existing release without modifying files.
"""

# /// script
# requires-python = ">=3.12"
# dependencies = ["packaging", "requests", "rich-argparse", "tomli", "tomlkit"]
#
# [tool.uv]
# exclude-newer = "P7D"
# no-build = true
# ///
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import requests
import tomli
import tomlkit
import tomlkit.items
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.version import Version
from rich_argparse import RawDescriptionRichHelpFormatter

PYPROJECT_TOML_PATH = Path("pyproject.toml")
PACKAGE_JSON_PATH = Path("package.json")
PACKAGE_LOCK_JSON_PATH = Path("package-lock.json")
README_PATH = Path("README.md")
CHANGELOG_PATH = Path("CHANGELOG.md")


@dataclass(frozen=True)
class Versions:
    existing_vscode_version: Version
    new_vscode_version: Version
    existing_ty_pin: Version
    latest_ty: Version


def existing_dependency_pin(
    dependencies: dict[str, SpecifierSet], dependency: str
) -> Version:
    """Return the version that `dependency` is currently pinned to in pyproject.toml."""
    specifiers = dependencies[dependency]
    assert len(specifiers) == 1
    single_specifier = next(iter(specifiers))
    assert single_specifier.operator == "=="
    return Version(single_specifier.version)


def latest_pypi_version(project_name: str) -> Version:
    """Determine the latest version of `project_name` that has been uploaded to PyPI."""
    pypi_json = requests.get(f"https://pypi.org/pypi/{project_name}/json")
    pypi_json.raise_for_status()
    return Version(pypi_json.json()["info"]["version"])


def get_ty_versions(
    *,
    new_ty_vscode_version: Version | None,
    new_ty_version: Version | None,
) -> Versions:
    """
    Obtain metadata about the project; figure out what the new metadata should be.
    """
    with PYPROJECT_TOML_PATH.open("rb") as pyproject_file:
        pyproject_toml = tomli.load(pyproject_file)

    existing_ty_vscode_version = Version(pyproject_toml["project"]["version"])

    if new_ty_vscode_version is None:
        major = dt.datetime.now(dt.timezone.utc).year
        minor = existing_ty_vscode_version.minor + 2
        new_ty_vscode_version = Version(f"{major}.{minor}.0")

    if new_ty_vscode_version <= existing_ty_vscode_version:
        raise SystemExit(
            f"Requested version {new_ty_vscode_version} must be greater than "
            f"current version {existing_ty_vscode_version}"
        )
    validate_version_increase(new_ty_vscode_version)

    dependencies = {
        requirement.name: requirement.specifier
        for requirement in map(Requirement, pyproject_toml["project"]["dependencies"])
    }

    return Versions(
        existing_vscode_version=existing_ty_vscode_version,
        new_vscode_version=new_ty_vscode_version,
        existing_ty_pin=existing_dependency_pin(dependencies, "ty"),
        latest_ty=(new_ty_version or latest_pypi_version("ty")),
    )


def plan_upstream_release(ty_version: str) -> None:
    """Select a stable extension release or resume publication after a merge."""
    if not re.fullmatch(r"(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}", ty_version):
        raise SystemExit(f"Expected a stable ty version, got {ty_version!r}")

    versions = get_ty_versions(
        new_ty_vscode_version=None, new_ty_version=Version(ty_version)
    )
    if versions.latest_ty < versions.existing_ty_pin:
        return

    current = versions.existing_vscode_version
    if versions.latest_ty == versions.existing_ty_pin and current.minor % 2 == 0:
        if subprocess.check_output(["git", "tag", "--list", str(current)]).strip():
            return
        # A retry after merge must still publish the commit that set this version.
        sha = subprocess.check_output(
            [
                "git",
                "log",
                "--first-parent",
                "-1",
                "--format=%H",
                "-G",
                rf'^version = "{re.escape(str(current))}"$',
                "--",
                str(PYPROJECT_TOML_PATH),
            ],
            text=True,
        ).strip()
        if not sha:
            raise SystemExit(f"Cannot find the release commit for {current}")
        print(f"version={current}")
        print(f"sha={sha}")
        return

    # Stable VS Code releases use even minor versions.
    next_stable_minor = current.minor + 2 - current.minor % 2
    print(f"version={versions.new_vscode_version.major}.{next_stable_minor}.0")
    print("prepare=true")


def update_pyproject_toml(versions: Versions) -> None:
    """Update metadata in `pyproject.toml`.

    Specifically, we update:
    - The version of this project itself
    - The `ty` version we pin to in our dependencies list
    """
    with PYPROJECT_TOML_PATH.open("rb") as pyproject_file:
        pyproject_toml = tomlkit.load(pyproject_file)

    project_table = pyproject_toml["project"]
    assert isinstance(project_table, tomlkit.items.Table)

    project_table["version"] = tomlkit.string(str(versions.new_vscode_version))

    existing_dependencies = project_table["dependencies"]
    assert isinstance(existing_dependencies, tomlkit.items.Array)
    assert len(existing_dependencies) == 1
    existing_dependencies[0] = tomlkit.string(f"ty=={versions.latest_ty}")

    with PYPROJECT_TOML_PATH.open("w") as pyproject_file:
        tomlkit.dump(pyproject_toml, pyproject_file)


def bump_package_json_version(new_version: Version) -> None:
    """Update the extension version in the npm manifest and lockfile."""
    for path in (PACKAGE_JSON_PATH, PACKAGE_LOCK_JSON_PATH):
        package = json.loads(path.read_bytes())
        package["version"] = str(new_version)
        if path == PACKAGE_LOCK_JSON_PATH:
            package["packages"][""]["version"] = str(new_version)
        path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n")


README_DESCRIPTION_REGEX = re.compile(
    r"The extension ships with `ty==\d+\.\d+\.\d+(a\d+)?`\."
)
README_SVG_REGEX = re.compile(r"ty/\d+\.\d+\.\d+(a\d+)?\.svg")


def update_readme(latest_ty: Version) -> None:
    """Ensure the README is up to date with respect to our pinned ty version."""
    readme_text = README_PATH.read_text()

    description_matches = list(README_DESCRIPTION_REGEX.finditer(readme_text))
    assert len(description_matches) == 1, (
        f"Unexpected number of matches for `README_DESCRIPTION_REGEX` "
        f"found in README.md ({len(description_matches)}). Perhaps the release script "
        f"is out of date?"
    )
    readme_text = "".join(
        [
            readme_text[: description_matches[0].start()],
            f"The extension ships with `ty=={latest_ty}`.",
            readme_text[description_matches[0].end() :],
        ]
    )

    assert README_SVG_REGEX.search(readme_text), (
        "No matches found for `README_SVG_REGEX` in README.md. "
        "Perhaps the release script is out of date?"
    )
    readme_text = README_SVG_REGEX.sub(f"ty/{latest_ty}.svg", readme_text)

    README_PATH.write_text(readme_text)


def locked_dependencies(lock: bytes) -> list[dict[str, object]]:
    """Return the dependency records a ty version bump must preserve."""
    dependencies = []
    for package in tomli.loads(lock.decode("utf-8"))["package"]:
        if package["source"] == {"virtual": "."}:
            continue
        if package["name"] == "ty":
            for key in ("version", "sdist", "wheels"):
                package.pop(key, None)
        dependencies.append(package)
    return dependencies


def update_ty_requirements() -> None:
    """Refresh ty's lock entry and export its distribution hashes for the build."""
    lockfile = Path("uv.lock")
    original = lockfile.read_bytes()
    try:
        requirements = subprocess.check_output(
            [
                "uv",
                "export",
                "--no-build",
                "--default-index",
                "https://pypi.org/simple",
                "--no-dev",
                "--no-emit-project",
            ]
        )
        if locked_dependencies(lockfile.read_bytes()) != locked_dependencies(original):
            raise SystemExit("The ty release would change other locked dependencies")
        Path("requirements.txt").write_bytes(requirements)
    except BaseException:
        lockfile.write_bytes(original)
        raise


def commit_changes(versions: Versions) -> None:
    """Create a new `git` branch, check it out, and commit the changes."""
    original_branch = subprocess.run(
        ["git", "branch", "--show-current"], text=True, check=True, capture_output=True
    ).stdout.strip()

    new_branch = f"release-{versions.new_vscode_version}"

    commit_body = f"Bump ty to {versions.latest_ty}"
    commit_command = [
        "git",
        "commit",
        "-a",
        "-m",
        f"Release {versions.new_vscode_version}",
        "-m",
        commit_body,
    ]

    try:
        subprocess.run(["git", "switch", "-c", new_branch], check=True)
        subprocess.run(commit_command, check=True)
    except:
        subprocess.run(["git", "switch", original_branch], check=True)
        raise


def prepare_release(versions: Versions, *, prepare_pr: bool) -> None:
    """Make all necessary changes for a new `ty-vscode` release."""
    update_pyproject_toml(versions)
    bump_package_json_version(versions.new_vscode_version)
    update_readme(versions.latest_ty)
    update_ty_requirements()
    if prepare_pr:
        commit_changes(versions)


VERSION_REGEX = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def validate_version_increase(version: Version) -> None:
    """Require a version greater than every existing release tag."""
    tags = subprocess.run(
        ["git", "tag", "--list"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    versions = [Version(tag) for tag in tags if VERSION_REGEX.fullmatch(tag)]
    if versions and version <= (latest_version := max(versions)):
        raise SystemExit(
            f"Requested version {version} must be greater than "
            f"latest release {latest_version}"
        )


def validate_release(version: str) -> bool:
    """Validate release metadata and return whether this is a pre-release."""
    if not VERSION_REGEX.fullmatch(version):
        raise SystemExit(f"Invalid extension version: {version!r}")

    parsed_version = Version(version)
    if str(parsed_version) != version:
        raise SystemExit(
            f"Requested version {version} was normalized to {parsed_version}"
        )

    with PACKAGE_JSON_PATH.open("rb") as package_file:
        package = json.load(package_file)
    with PYPROJECT_TOML_PATH.open("rb") as project_file:
        project = tomli.load(project_file)["project"]
    for path, metadata in [
        (PACKAGE_JSON_PATH, package),
        (PYPROJECT_TOML_PATH, project),
    ]:
        if metadata["version"] != version:
            raise SystemExit(
                f"Requested version {version} does not match "
                f"{path} version {metadata['version']}"
            )

    validate_version_increase(parsed_version)

    return parsed_version.minor % 2 != 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=RawDescriptionRichHelpFormatter
    )
    parser.add_argument(
        "--validate",
        metavar="VERSION",
        help=(
            "Validate an existing release without modifying files; "
            "prints prerelease=true or prerelease=false"
        ),
    )
    parser.add_argument(
        "--prepare-pr",
        action="store_true",
        help="After preparing the release, commit the results to a new branch",
    )
    parser.add_argument(
        "--new-version",
        type=Version,
        help=(
            "The version to set for this release. "
            "Defaults to `${CURRENT_MAJOR}.${CURRENT_MINOR + 2}.0`"
        ),
    )
    parser.add_argument(
        "--new-ty",
        type=Version,
        help=(
            "Which version to bump the `ty` dependency pin to. "
            "Defaults to the latest version available on PyPI."
        ),
    )
    parser.add_argument(
        "--plan-upstream",
        metavar="TY_VERSION",
        help="Print the release workflow outputs for an upstream ty release.",
    )
    args = parser.parse_args()
    if args.plan_upstream is not None:
        if (
            args.validate is not None
            or args.prepare_pr
            or args.new_version is not None
            or args.new_ty is not None
        ):
            parser.error("--plan-upstream must be used on its own")
        plan_upstream_release(args.plan_upstream)
        return
    if args.validate is not None:
        if args.prepare_pr or args.new_version is not None or args.new_ty is not None:
            parser.error(
                "--validate cannot be combined with release preparation options"
            )
        prerelease = validate_release(args.validate)
        print(f"prerelease={str(prerelease).lower()}")
        return

    versions = get_ty_versions(
        new_ty_vscode_version=args.new_version,
        new_ty_version=args.new_ty,
    )
    prepare_release(versions, prepare_pr=args.prepare_pr)


if __name__ == "__main__":
    main()
