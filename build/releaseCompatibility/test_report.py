# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import report


def write_vsix(file, name, version, pet=False, target="win32-x64"):
    with zipfile.ZipFile(file, "w") as archive:
        archive.writestr("extension/package.json", json.dumps({
            "publisher": "ms-python", "name": name, "version": version,
        }))
        archive.writestr("extension.vsixmanifest", (
            '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
            f'<Metadata><Identity Publisher="ms-python" Id="{name}" Version="{version}" '
            f'TargetPlatform="{target}"/></Metadata></PackageManifest>'
        ))
        if pet:
            archive.writestr("extension/python-env-tools/bin/pet.exe", b"fixture, not executable")


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidates = self.root / "candidate"
        self.candidates.mkdir()
        self.candidate = self.candidates / "candidate.vsix"
        write_vsix(self.candidate, "vscode-python-envs", "1.43.123")
        self.payload = self.root / "payload"
        self.payload.mkdir()
        write_vsix(self.payload / "core.vsix", "python", "2026.10.0", pet=True)
        write_vsix(self.payload / "baseline.vsix", "vscode-python-envs", "1.42.0", pet=True)
        with zipfile.ZipFile(self.payload / "harness.zip", "w") as archive:
            archive.writestr("run.js", "// Unit fixture only. Never starts VS Code.\n")
        self.inputs = {
            "schemaVersion": 1,
            "vscodeVersion": "1.110.0",
            "core": {
                "path": "core.vsix", "version": "2026.10.0", "sha256": report.sha256(self.payload / "core.vsix"),
            },
            "upgradeFromEnvironments": {
                "path": "baseline.vsix", "version": "1.42.0", "pet": "bundled",
                "sha256": report.sha256(self.payload / "baseline.vsix"),
            },
            "harness": {"path": "harness.zip", "sha256": report.sha256(self.payload / "harness.zip")},
        }
        self.inputs_zip = self.root / "inputs.zip"
        self.output = self.root / "result"

    def pack_inputs(self):
        (self.payload / "inputs.json").write_text(json.dumps(self.inputs), encoding="utf-8")
        with zipfile.ZipFile(self.inputs_zip, "w") as archive:
            for file in self.payload.iterdir():
                archive.write(file, file.name)
        return report.sha256(self.inputs_zip)

    def run_adapter(self, status="passed", code=0, missing_report=False, expected_hash=None):
        digest = self.pack_inputs()

        def fake_runner(command, **kwargs):
            self.command = command
            self.environment = kwargs["env"]
            runner_output = self.output / "runner"
            runner_output.mkdir()
            if not missing_report:
                (runner_output / "report.json").write_text(json.dumps({"status": status}), encoding="utf-8")
            return subprocess.CompletedProcess(command, code)

        with patch.object(report.shutil, "which", return_value="node"), patch.object(
            report.subprocess, "run", side_effect=fake_runner,
        ) as runner:
            result = report.run_report(
                self.candidates, self.inputs_zip, expected_hash or digest, self.output,
            )
            self.runner_called = runner.called
        return result, report.read_object(self.output / "adapter-report.json")

    def test_build_artifact_is_not_repacked_and_upgrade_is_required(self):
        original = self.candidate.read_bytes()
        code, result = self.run_adapter()
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["scope"], "pre-sign-build-artifact")
        self.assertFalse(result["finalSignedArtifactValidated"])
        self.assertTrue(result["reportOnly"])
        self.assertEqual(self.candidate.read_bytes(), original)
        plan = report.read_object(self.output / "plan.json")
        self.assertEqual(plan["candidate"], "environments")
        self.assertEqual(plan["environments"]["pet"], "omitted")
        self.assertEqual(plan["upgradeFromEnvironments"]["pet"], "bundled")
        self.assertTrue(Path(plan["core"]["path"]).is_absolute())
        self.assertIn("--plan", self.command)
        self.assertNotIn("--extensionDevelopmentPath", self.command)

    def test_candidate_with_pet_fails_before_runner(self):
        write_vsix(self.candidate, "vscode-python-envs", "1.43.123", pet=True)
        code, result = self.run_adapter()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "failed")
        self.assertIn("unexpectedly bundles PET", result["error"])
        self.assertFalse(self.runner_called)

    def test_wrong_candidate_platform_fails_before_runner(self):
        write_vsix(self.candidate, "vscode-python-envs", "1.43.123", target="win32-arm64")
        code, result = self.run_adapter()
        self.assertEqual(code, 1)
        self.assertIn("win32-x64", result["error"])
        self.assertFalse(self.runner_called)

    def test_missing_and_ambiguous_candidate_are_infrastructure_errors(self):
        for count in (0, 2):
            with self.subTest(count=count):
                directory = self.root / f"candidates-{count}"
                directory.mkdir()
                for index in range(count):
                    write_vsix(directory / f"{index}.vsix", "vscode-python-envs", "1.43.123")
                output = self.root / f"output-{count}"
                code = report.run_report(directory, self.inputs_zip, "0" * 64, output)
                self.assertEqual(code, 2)
                self.assertIn("exactly one", report.read_object(output / "adapter-report.json")["error"])

    def test_unpinned_or_mismatched_inputs_never_run(self):
        for value in ("latest", "0" * 64):
            with self.subTest(value=value):
                self.output = self.root / value
                code, result = self.run_adapter(expected_hash=value)
                self.assertEqual(code, 2)
                self.assertEqual(result["status"], "infrastructure-error")
                self.assertFalse(self.runner_called)

    def test_wrong_version_missing_pet_and_missing_upgrade_are_not_skipped(self):
        cases = ("version", "pet", "platform", "upgrade", "vscode", "harness", "path")
        original_core = (self.payload / "core.vsix").read_bytes()
        for case in cases:
            with self.subTest(case=case):
                saved = json.loads(json.dumps(self.inputs))
                self.output = self.root / case
                if case == "version":
                    self.inputs["core"]["version"] = "2026.8.0"
                elif case == "pet":
                    write_vsix(self.payload / "core.vsix", "python", "2026.10.0")
                    self.inputs["core"]["sha256"] = report.sha256(self.payload / "core.vsix")
                elif case == "platform":
                    write_vsix(self.payload / "core.vsix", "python", "2026.10.0", pet=True, target="linux-x64")
                    self.inputs["core"]["sha256"] = report.sha256(self.payload / "core.vsix")
                elif case == "upgrade":
                    del self.inputs["upgradeFromEnvironments"]
                elif case == "vscode":
                    self.inputs["vscodeVersion"] = "stable"
                elif case == "harness":
                    self.inputs["harness"]["sha256"] = "0" * 64
                else:
                    self.inputs["core"]["path"] = str(self.root / "outside.vsix")
                code, result = self.run_adapter()
                self.assertEqual(code, 2)
                self.assertFalse(self.runner_called)
                self.assertIn("error", result)
                self.inputs = saved
                (self.payload / "core.vsix").write_bytes(original_core)

    def test_runner_failure_and_infrastructure_failure_remain_distinct(self):
        for code, status in ((1, "failed"), (2, "infrastructure-error")):
            with self.subTest(status=status):
                self.output = self.root / status
                actual, result = self.run_adapter(status=status, code=code)
                self.assertEqual(actual, code)
                self.assertEqual(result["status"], status)

    def test_missing_report_and_success_status_with_failure_exit_are_infrastructure_errors(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.output = self.root / str(missing)
                code, result = self.run_adapter(code=1, missing_report=missing)
                self.assertEqual(code, 2)
                self.assertEqual(result["status"], "infrastructure-error")

    def test_candidate_environment_does_not_inherit_credentials_or_profile(self):
        with patch.dict(os.environ, {
            "SYSTEM_ACCESSTOKEN": "test-token", "AZURE_CLIENT_SECRET": "test-secret",
            "GH_TOKEN": "test-token", "NODE_OPTIONS": "--require untrusted.js",
            "PYTHONPATH": "untrusted", "USERPROFILE": "developer-profile",
        }):
            self.run_adapter()
        for name in ("SYSTEM_ACCESSTOKEN", "AZURE_CLIENT_SECRET", "GH_TOKEN", "NODE_OPTIONS", "PYTHONPATH"):
            self.assertNotIn(name, self.environment)
        self.assertEqual(self.environment["USERPROFILE"], str(self.output / "home"))

    def test_archive_rejects_traversal_absolute_paths_duplicates_and_links(self):
        for index, name in enumerate(("../escape", "/absolute", "C:/escape", "folder\\escape", "nul.txt", "a/../b")):
            with self.subTest(name=name):
                archive_path = self.root / f"bad-{index}.zip"
                with zipfile.ZipFile(archive_path, "w") as archive:
                    entry = zipfile.ZipInfo("placeholder")
                    entry.filename = name
                    archive.writestr(entry, "bad")
                with self.assertRaises(ValueError):
                    report.extract_archive(archive_path, self.root / f"extract-{index}")
        for kind in ("duplicate", "link"):
            with self.subTest(kind=kind):
                archive_path = self.root / f"{kind}.zip"
                with zipfile.ZipFile(archive_path, "w") as archive:
                    archive.writestr("run.js", "first")
                    if kind == "duplicate":
                        archive.writestr("RUN.js", "second")
                    else:
                        link = zipfile.ZipInfo("link")
                        link.external_attr = (stat.S_IFLNK | 0o777) << 16
                        archive.writestr(link, "run.js")
                with self.assertRaises(ValueError):
                    report.extract_archive(archive_path, self.root / kind)

    def test_existing_output_cannot_supply_stale_success(self):
        self.output.mkdir()
        (self.output / "adapter-report.json").write_text('{"status":"passed"}', encoding="utf-8")
        with self.assertRaises(FileExistsError):
            report.run_report(self.candidates, self.inputs_zip, "0" * 64, self.output)

    def test_corrupt_compressed_inputs_produce_infrastructure_evidence(self):
        with zipfile.ZipFile(self.inputs_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("inputs.json", "not a valid input manifest")
        raw = bytearray(self.inputs_zip.read_bytes())
        with zipfile.ZipFile(self.inputs_zip) as archive:
            entry = archive.getinfo("inputs.json")
            offset = entry.header_offset + 30 + len(entry.filename.encode("utf-8")) + len(entry.extra)
            raw[offset:offset + entry.compress_size] = b"\xff" * entry.compress_size
        self.inputs_zip.write_bytes(raw)
        code = report.run_report(self.candidates, self.inputs_zip, report.sha256(self.inputs_zip), self.output)
        self.assertEqual(code, 2)
        result = report.read_object(self.output / "adapter-report.json")
        self.assertEqual(result["status"], "infrastructure-error")
        self.assertIn("Error -3", result["error"])

    def test_preparation_warning_is_an_infrastructure_error_not_a_fallback_pass(self):
        digest = self.pack_inputs()
        with patch.object(report.subprocess, "run") as runner:
            code = report.run_report(
                self.candidates, self.inputs_zip, digest, self.output, "SucceededWithIssues",
            )
        self.assertEqual(code, 2)
        self.assertFalse(runner.called)
        result = report.read_object(self.output / "adapter-report.json")
        self.assertEqual(result["status"], "infrastructure-error")
        self.assertEqual(result["preparationStatus"], "SucceededWithIssues")

    def test_real_node_subprocess_contract_with_inert_runner(self):
        self.assertIsNotNone(report.shutil.which("node"), "This adapter check requires Node.js")
        for expected_code, expected_status in ((0, "passed"), (1, "failed"), (2, "infrastructure-error")):
            with self.subTest(status=expected_status):
                self.output = self.root / f"process-{expected_code}"
                with zipfile.ZipFile(self.payload / "harness.zip", "w") as archive:
                    archive.writestr("run.js", f"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
assert.equal(args.length, 4);
assert.equal(args[0], '--plan');
assert.equal(args[2], '--output');
assert.equal(path.isAbsolute(args[1]), true);
assert.equal(path.isAbsolute(args[3]), true);
assert.equal(fs.existsSync(args[3]), false);
const plan = JSON.parse(fs.readFileSync(args[1], 'utf8'));
assert.equal(plan.candidate, 'environments');
assert.equal(plan.environments.pet, 'omitted');
assert.equal(plan.upgradeFromEnvironments.pet, 'bundled');
for (const name of ['GH_TOKEN', 'SYSTEM_ACCESSTOKEN', 'NODE_OPTIONS', 'PYTHONPATH']) {{
    assert.equal(process.env[name], undefined);
}}
fs.mkdirSync(args[3]);
fs.writeFileSync(path.join(args[3], 'report.json'), JSON.stringify({{status: '{expected_status}'}}));
process.exitCode = {expected_code};
""")
                self.inputs["harness"]["sha256"] = report.sha256(self.payload / "harness.zip")
                digest = self.pack_inputs()
                with patch.dict(os.environ, {
                    "GH_TOKEN": "fixture-token", "SYSTEM_ACCESSTOKEN": "fixture-token",
                    "NODE_OPTIONS": "--require nonexistent-fixture", "PYTHONPATH": "fixture-path",
                }):
                    code = report.run_report(self.candidates, self.inputs_zip, digest, self.output)
                self.assertEqual(code, expected_code)
                self.assertEqual(report.read_object(self.output / "adapter-report.json")["status"], expected_status)


if __name__ == "__main__":
    unittest.main()
