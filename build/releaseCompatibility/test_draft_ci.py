# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import draft_ci
import report
from test_report import write_vsix


class DraftCiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        driver = self.source / "build" / "releaseCompatibility" / "report.py"
        driver.parent.mkdir(parents=True)
        driver.write_bytes(Path(report.__file__).read_bytes())
        (self.source / "package.json").write_text('{"version":"1.43.0"}', encoding="utf-8")
        self.harness_source = self.root / "harness-source"
        self.harness_source.mkdir()
        (self.harness_source / "package-lock.json").write_text('{"lockfileVersion":3}', encoding="utf-8")
        self.lock_sha = report.sha256(self.harness_source / "package-lock.json")
        self.candidate = self.root / "candidate.vsix"
        write_vsix(self.candidate, "vscode-python-envs", "1.43.0")
        self.core = self.root / "core.vsix"
        self.baseline = self.root / "baseline.vsix"
        write_vsix(self.core, "python", "2026.10.0", pet=True)
        write_vsix(self.baseline, "vscode-python-envs", "1.42.0", pet=True)
        self.config = {
            "schemaVersion": 1, "purpose": "draft-ci-verification", "draftPullRequest": 1994,
            "vscodeVersion": "1.110.0",
            "harness": {
                "repository": "microsoft/vscode-python", "commit": "a" * 40,
                "repositoryLockSha256": self.lock_sha,
            },
            "core": {
                "version": "2026.10.0", "sha256": report.sha256(self.core),
                "downloadUrl": "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/python/2026.10.0/vspackage?targetPlatform=win32-x64",
            },
            "upgradeFromEnvironments": {
                "version": "1.42.0", "sha256": report.sha256(self.baseline),
                "downloadUrl": "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/vsextensions/vscode-python-envs/1.42.0/vspackage?targetPlatform=win32-x64",
            },
        }
        self.config_file = self.root / "draft.json"
        self.harness = self.root / "harness.zip"
        self.make_harness()
        self.output = self.root / "prepared"

    def make_harness(self, extra=False, corrupt=False):
        files = {
            "run.js": b"// Inert unit fixture, not an installed-product runner.",
            "checks.js": b"// Inert fixture.",
            "process.ps1": b"# Inert fixture.",
            "controller/index.js": b"// Inert fixture.",
            "node_modules/@vscode/test-electron/package.json": b'{"version":"3.1.0"}',
        }
        manifest = {
            "schemaVersion": 1, "repositoryLockSha256": self.lock_sha,
            "files": [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()],
        }
        if corrupt:
            manifest["files"][0]["sha256"] = "0" * 64
        with zipfile.ZipFile(self.harness, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
            archive.writestr("harness-manifest.json", json.dumps(manifest))
            if extra:
                archive.writestr("unreviewed.js", "extra")

    def prepare(self):
        def download(url, **_kwargs):
            file = self.core if "/python/" in url else self.baseline
            return io.BytesIO(file.read_bytes())

        with patch.object(draft_ci, "verify_snapshot") as snapshots, patch.object(
            draft_ci.urllib.request, "urlopen", side_effect=download,
        ):
            result = draft_ci.prepare(
                self.config, self.source, "example/vscode-python-environments", "b" * 40,
                self.harness_source, self.candidate, self.harness, self.output,
            )
        self.assertEqual(snapshots.call_count, 2)
        return result

    def test_only_explicit_draft_is_selected(self):
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(draft_ci.read_config(self.config_file), self.config)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(self.root / "outputs")}):
            self.assertEqual(draft_ci.describe(self.config, 1994, True)["enabled"], "true")
            self.assertEqual(draft_ci.describe(self.config, 1994, False)["enabled"], "false")
            self.assertEqual(draft_ci.describe(self.config, 1995, True)["enabled"], "false")

    def test_moving_refs_wrong_platform_urls_and_missing_pins_are_rejected(self):
        for field in ("commit", "repository", "lock", "hash", "version", "url", "scope", "schema"):
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                if field == "commit":
                    config["harness"]["commit"] = "main"
                elif field == "repository":
                    config["harness"]["repository"] = "example/unrelated"
                elif field == "lock":
                    config["harness"]["repositoryLockSha256"] = "latest"
                elif field == "hash":
                    config["core"]["sha256"] = ""
                elif field == "version":
                    config["vscodeVersion"] = "stable"
                elif field == "url":
                    config["core"]["downloadUrl"] += "&latest=true"
                elif field == "scope":
                    config["draftPullRequest"] = True
                else:
                    config["schemaVersion"] = True
                self.config_file.write_text(json.dumps(config), encoding="utf-8")
                with self.assertRaises(ValueError):
                    draft_ci.read_config(self.config_file)

    def test_prepared_artifact_preserves_exact_candidate_inputs_and_driver(self):
        original = self.candidate.read_bytes()
        result = self.prepare()
        self.assertFalse(result["runtimeValidated"])
        self.assertEqual(result["source"]["commit"], "b" * 40)
        self.assertEqual(result["harness"]["commit"], "a" * 40)
        self.assertEqual(result["candidate"]["sha256"], report.sha256(self.candidate))
        self.assertEqual((self.output / "candidate" / "environments.vsix").read_bytes(), original)
        self.assertEqual(result["inputsSha256"], report.sha256(self.output / "inputs.zip"))
        with zipfile.ZipFile(self.output / "inputs.zip") as archive:
            inputs = json.loads(archive.read("inputs.json"))
            self.assertEqual(inputs["upgradeFromEnvironments"]["pet"], "bundled")
            self.assertEqual(inputs["vscodeVersion"], "1.110.0")
            self.assertEqual(archive.read("python.vsix"), self.core.read_bytes())
            self.assertEqual(archive.read("harness.zip"), self.harness.read_bytes())
        self.assertEqual(result["driverSha256"], report.sha256(self.output / "adapter" / "report.py"))

    def test_dirty_wrong_source_or_remote_is_not_claimed_as_pinned(self):
        good = ["a" * 40, "https://github.com/microsoft/vscode-python", ""]
        for field in (0, 1, 2):
            with self.subTest(field=field):
                replies = good.copy()
                replies[field] = ("b" * 40, "https://github.com/example/wrong", " M source.js")[field]
                with patch.object(draft_ci.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess("git", 0, stdout=value) for value in replies
                ]):
                    with self.assertRaises(ValueError):
                        draft_ci.verify_snapshot(self.source, "microsoft/vscode-python", "a" * 40)

    def test_wrong_partner_bytes_and_wrong_lock_fail_preparation(self):
        self.config["core"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            self.prepare()
        self.config["core"]["sha256"] = report.sha256(self.core)
        self.config["harness"]["repositoryLockSha256"] = "0" * 64
        with self.assertRaises(ValueError):
            self.prepare()

    def test_harness_manifest_hash_and_unlisted_file_are_not_trusted(self):
        for extra, corrupt in ((True, False), (False, True)):
            with self.subTest(extra=extra, corrupt=corrupt):
                self.make_harness(extra=extra, corrupt=corrupt)
                with self.assertRaises(ValueError):
                    draft_ci.verify_harness(self.harness)

    def test_existing_preparation_output_cannot_be_reused(self):
        self.output.mkdir()
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_candidate_with_pet_cannot_be_certified_as_cutover(self):
        write_vsix(self.candidate, "vscode-python-envs", "1.43.0", pet=True)
        with self.assertRaises(ValueError):
            self.prepare()


if __name__ == "__main__":
    unittest.main()
