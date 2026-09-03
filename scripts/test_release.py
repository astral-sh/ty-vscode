"""Regression tests for release version ordering."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release
from packaging.version import Version


class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.package_json = Path(directory) / "package.json"
        self.pyproject_toml = Path(directory) / "pyproject.toml"
        self.enterContext(patch.object(release, "PACKAGE_JSON_PATH", self.package_json))
        self.enterContext(
            patch.object(release, "PYPROJECT_TOML_PATH", self.pyproject_toml)
        )
        self.git = self.enterContext(patch.object(release.subprocess, "run"))
        self.git.return_value.stdout = ""

    def set_version(self, version):
        self.package_json.write_text(json.dumps({"version": version}))
        self.pyproject_toml.write_text(
            f'[project]\nversion = "{version}"\ndependencies = ["ty==0.0.76"]\n'
        )

    def prepare(self, version):
        return release.get_ty_versions(
            new_ty_vscode_version=Version(version), new_ty_version=Version("0.0.76")
        )

    def test_preparation_rejects_current_or_older_version_without_tags(self):
        self.set_version("2026.70.0")
        for version in ["2026.69.0", "2026.70.0", "2025.100.0"]:
            with self.subTest(version=version):
                with self.assertRaisesRegex(SystemExit, "current version 2026.70.0"):
                    self.prepare(version)

    def test_preparation_accepts_newer_versions(self):
        self.set_version("2026.70.0")
        for version in ["2026.70.1", "2026.71.0", "2026.72.0", "2027.0.0"]:
            with self.subTest(version=version):
                self.assertEqual(
                    self.prepare(version).new_vscode_version, Version(version)
                )

    def test_preparation_rejects_versions_behind_release_tags(self):
        self.set_version("2026.68.0")
        self.git.return_value.stdout = "2026.70.0\n2026.9.0\n"
        for version in ["2026.69.0", "2026.70.0"]:
            with self.subTest(version=version):
                with self.assertRaisesRegex(SystemExit, "latest release 2026.70.0"):
                    self.prepare(version)

    def test_validation_rejects_current_or_older_release(self):
        for latest in ["2026.70.0", "2026.71.0"]:
            self.git.return_value.stdout = f"{latest}\n2026.9.0\n"
            for version in ["2026.69.0", "2026.70.0", latest]:
                with self.subTest(latest=latest, version=version):
                    self.set_version(version)
                    with self.assertRaisesRegex(SystemExit, f"latest release {latest}"):
                        release.validate_release(version)

    def test_validation_accepts_newer_releases(self):
        for latest, version, prerelease in [
            ("2026.9.0", "2026.10.0", False),
            ("2026.70.0", "2026.70.1", False),
            ("2026.70.0", "2026.71.0", True),
            ("2026.71.0", "2026.72.0", False),
            ("2026.100.0", "2027.0.0", False),
        ]:
            with self.subTest(latest=latest, version=version):
                self.git.return_value.stdout = f"{latest}\n"
                self.set_version(version)
                self.assertEqual(release.validate_release(version), prerelease)

    def test_validation_allows_no_release_tags(self):
        self.set_version("2026.1.0")
        for tags in ["", "not-a-release\n"]:
            with self.subTest(tags=tags):
                self.git.return_value.stdout = tags
                self.assertTrue(release.validate_release("2026.1.0"))

    def test_validation_fails_if_tags_cannot_be_read(self):
        self.set_version("2026.71.0")
        self.git.side_effect = subprocess.CalledProcessError(
            1, ["git", "tag", "--list"]
        )
        with self.assertRaises(subprocess.CalledProcessError):
            release.validate_release("2026.71.0")


if __name__ == "__main__":
    unittest.main()
