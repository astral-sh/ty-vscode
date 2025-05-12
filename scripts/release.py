"""
Script for automating changes necessary for `ty-vscode` releases.

This script does the following things:
- Bumps the version of this project in `pyproject.toml` and `package.json`
- Bumps the `ty` dependency pin in `pyproject.toml`
- Updates the changelog and README
- Updates the package's lockfiles
"""

# /// script
# requires-python = ">=3.8"
# dependencies = ["packaging", "requests", "rich-argparse", "tomli", "tomlkit"]
#
# [tool.uv]
# exclude-newer = "2024-11-27T00:00:00Z"
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
    """Update the version of this package in `package.json`."""
    with PACKAGE_JSON_PATH.open("rb") as package_json_file:
        package_json = json.load(package_json_file)
    package_json["version"] = str(new_version)
    with PACKAGE_JSON_PATH.open("w") as package_json_file:
        json.dump(package_json, package_json_file, indent=2)
        package_json_file.write("\n")


README_DESCRIPTION_REGEX = re.compile(r"The extension ships with `ty==\d+\.\d+\.\d+`\.")
README_SVG_REGEX = re.compile(r"ty/\d+\.\d+\.\d+\.svg")


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


def lock_requirements() -> None:
    """Update this package's lockfiles."""
    for path in ["requirements.txt"]:
        Path(path).unlink()
    subprocess.run(["just", "lock"], check=True)


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
    lock_requirements()
    if prepare_pr:
        commit_changes(versions)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=RawDescriptionRichHelpFormatter
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
    args = parser.parse_args()
    versions = get_ty_versions(
        new_ty_vscode_version=args.new_version,
        new_ty_version=args.new_ty,
    )
    prepare_release(versions, prepare_pr=args.prepare_pr)


if __name__ == "__main__":
    main()
