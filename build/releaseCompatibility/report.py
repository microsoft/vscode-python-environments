# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Adapt a DevDiv Build artifact to the shared installed-VSIX compatibility runner."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib


STATUSES = {0: "passed", 1: "failed", 2: "infrastructure-error"}
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
SHA256 = re.compile(r"[a-fA-F0-9]{64}")


class CompatibilityFailure(ValueError):
    """A candidate violates the package contract rather than failing to run a check."""


def sha256(file):
    """Return the SHA-256 of a file without loading its contents into memory."""
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(file, expected):
    """Check a required, exact SHA-256 before consuming an external input."""
    if not isinstance(expected, str) or not SHA256.fullmatch(expected):
        raise ValueError(f"A complete SHA-256 is required for {file.name}")
    actual = sha256(file)
    if actual != expected.lower():
        raise ValueError(f"SHA-256 mismatch for {file.name}: expected {expected.lower()}, got {actual}")
    return actual


def read_object(file):
    """Read a JSON object; arrays and scalar JSON are not valid input manifests."""
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {file}")
    return value


def extract_archive(file, destination):
    """Extract a hash-verified input ZIP, rejecting traversal, links and duplicate paths."""
    destination.mkdir()
    seen = set()
    with zipfile.ZipFile(file) as archive:
        if sum(item.file_size for item in archive.infolist()) > MAX_EXTRACTED_BYTES:
            raise ValueError(f"Input archive exceeds the {MAX_EXTRACTED_BYTES}-byte extraction limit")
        for item in archive.infolist():
            name = item.orig_filename
            parts = PurePosixPath(name).parts
            mode = item.external_attr >> 16
            if (
                not parts
                or name.startswith("/")
                or "\\" in name
                or ":" in name
                or any(ord(char) < 32 for char in name)
                or any(part in (".", "..") or part.endswith((" ", ".")) for part in parts)
                or any(re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?", part) for part in parts)
                or stat.S_ISLNK(mode)
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))
                or item.flag_bits & 1
                or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            ):
                raise ValueError(f"Non-portable or unsafe input ZIP entry: {name!r}")
            key = "/".join(parts).casefold()
            if key in seen:
                raise ValueError(f"Duplicate input ZIP entry: {name!r}")
            seen.add(key)
            target = destination.joinpath(*parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                if mode & 0o777:
                    target.chmod(mode & 0o777)


def input_path(directory, value):
    """Resolve a manifest file reference strictly inside the extracted inputs."""
    if not isinstance(value, str) or not value:
        raise ValueError("An input file path is required")
    file = (directory / value).resolve()
    if Path(value).is_absolute() or not file.is_relative_to(directory.resolve()) or not file.is_file():
        raise ValueError(f"Missing input file or path outside the inputs directory: {value!r}")
    return file


def inspect_vsix(file, expected_name):
    """Inspect package identity and PET contents directly from the original VSIX bytes."""
    with zipfile.ZipFile(file) as archive:
        for name in ("extension/package.json", "extension.vsixmanifest"):
            if archive.namelist().count(name) != 1:
                raise ValueError(f"{file.name} must contain exactly one {name}")
            entry = archive.getinfo(name)
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError(f"Encrypted or unsupported VSIX manifest in {file.name}")
        manifest = json.loads(archive.read("extension/package.json"))
        if not isinstance(manifest, dict) or manifest.get("publisher") != "ms-python" or manifest.get("name") != expected_name:
            raise ValueError(f"Unexpected extension identity in {file.name}")
        version = manifest.get("version")
        if not isinstance(version, str) or not SEMVER.fullmatch(version):
            raise ValueError(f"An exact numeric extension version is required in {file.name}")
        namespace = "{http://schemas.microsoft.com/developer/vsx-schema/2011}"
        package = ET.fromstring(archive.read("extension.vsixmanifest"))
        identity = package.find(f"{namespace}Metadata/{namespace}Identity")
        if identity is None or any(
            identity.get(key) != value
            for key, value in (("Publisher", "ms-python"), ("Id", expected_name), ("Version", version))
        ):
            raise ValueError(f"VSIX identity and package.json disagree in {file.name}")
        target = identity.get("TargetPlatform")
        pet = []
        for name in archive.namelist():
            if name.casefold() in (
                "extension/python-env-tools/bin/pet",
                "extension/python-env-tools/bin/pet.exe",
            ):
                entry = archive.getinfo(name)
                if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError(f"Encrypted or unsupported PET binary in {file.name}")
                pet.append({"path": name, "sha256": hashlib.sha256(archive.read(name)).hexdigest()})
    return {
        "path": str(file.resolve()), "version": version, "sha256": sha256(file),
        "targetPlatform": target, "petFiles": pet,
    }


def pinned_partner(inputs, name, directory, extension_name):
    """Verify a pinned released partner's bytes, identity, version and bundled PET."""
    partner = inputs.get(name)
    if not isinstance(partner, dict):
        raise ValueError(f"Missing pinned {name} artifact")
    file = input_path(directory, partner.get("path"))
    require_hash(file, partner.get("sha256"))
    identity = inspect_vsix(file, extension_name)
    if identity["version"] != partner.get("version"):
        raise ValueError(f"Pinned {name} version does not match the VSIX manifest")
    if identity["targetPlatform"] != "win32-x64":
        raise ValueError(f"Pinned {name} must be a win32-x64 VSIX for this check")
    if not any(binary["path"].casefold().endswith("/pet.exe") for binary in identity["petFiles"]):
        raise ValueError(f"Pinned {name} must bundle Windows PET for this fallback/upgrade check")
    result = {key: identity[key] for key in ("path", "version", "sha256")}
    if "provenance" in partner:
        if not isinstance(partner["provenance"], dict):
            raise ValueError(f"{name}.provenance must be an object")
        result["provenance"] = partner["provenance"]
    return result


def candidate_environment(output):
    """Keep candidate processes out of the agent's credentials and normal user profile."""
    allowed = {
        "path", "pathext", "systemroot", "windir", "comspec", "programfiles",
        "programfiles(x86)", "programw6432", "display", "xauthority", "lang", "lc_all",
    }
    environment = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    home = output / "home"
    temp = output / "temp"
    home.mkdir()
    temp.mkdir()
    environment.update({
        "HOME": str(home), "USERPROFILE": str(home),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "XDG_CONFIG_HOME": str(home / "config"), "XDG_CACHE_HOME": str(home / "cache"),
        "XDG_DATA_HOME": str(home / "data"),
        "TEMP": str(temp), "TMP": str(temp), "TMPDIR": str(temp),
        "PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1",
    })
    return environment


def run_report(candidate_directory, inputs_zip, inputs_sha256, output, preparation_status="Succeeded"):
    """Run the pre-sign, report-only check and persist both success and failure evidence."""
    output.mkdir(parents=True)
    report_file = output / "adapter-report.json"
    report = {
        "schemaVersion": 1,
        "scope": "pre-sign-build-artifact",
        "reportOnly": True,
        "status": "infrastructure-error",
        "finalSignedArtifactValidated": False,
        "preparationStatus": preparation_status,
    }

    def save():
        report_file.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    save()
    try:
        if preparation_status != "Succeeded":
            raise ValueError(f"Compatibility preparation did not succeed: {preparation_status}")
        candidates = sorted(candidate_directory.glob("*.vsix"))
        if len(candidates) != 1:
            raise ValueError(f"Expected exactly one candidate VSIX, found {len(candidates)} in {candidate_directory}")
        report["candidate"] = inspect_vsix(candidates[0], "vscode-python-envs")
        if report["candidate"]["targetPlatform"] != "win32-x64":
            raise CompatibilityFailure("The candidate must be a win32-x64 VSIX")
        if report["candidate"]["petFiles"]:
            raise CompatibilityFailure("The DevDiv Environments candidate unexpectedly bundles PET")
        report["inputsSha256"] = require_hash(inputs_zip, inputs_sha256)
        input_directory = output / "inputs"
        extract_archive(inputs_zip, input_directory)
        inputs = read_object(input_directory / "inputs.json")
        if inputs.get("schemaVersion") != 1 or isinstance(inputs.get("schemaVersion"), bool):
            raise ValueError("Unsupported compatibility inputs schemaVersion")
        vscode_version = inputs.get("vscodeVersion")
        if not isinstance(vscode_version, str) or not SEMVER.fullmatch(vscode_version):
            raise ValueError("vscodeVersion must be an exact stable major.minor.patch version")
        core = pinned_partner(inputs, "core", input_directory, "python")
        baseline = pinned_partner(inputs, "upgradeFromEnvironments", input_directory, "vscode-python-envs")
        if inputs["upgradeFromEnvironments"].get("pet") != "bundled":
            raise ValueError("upgradeFromEnvironments.pet must be 'bundled'")
        baseline["pet"] = "bundled"
        candidate = {key: report["candidate"][key] for key in ("path", "version", "sha256")}
        candidate["pet"] = "omitted"
        plan = {
            "schemaVersion": 1, "candidate": "environments", "vscodeVersion": vscode_version,
            "pythonExecutable": sys.executable, "core": core, "environments": candidate,
            "upgradeFromEnvironments": baseline,
        }
        harness = inputs.get("harness")
        if not isinstance(harness, dict):
            raise ValueError("A reviewed, self-contained harness ZIP and SHA-256 are required")
        harness_zip = input_path(input_directory, harness.get("path"))
        report["harnessSha256"] = require_hash(harness_zip, harness.get("sha256"))
        harness_directory = output / "harness"
        extract_archive(harness_zip, harness_directory)
        runner = input_path(harness_directory, "run.js")
        node = shutil.which("node")
        if node is None:
            raise ValueError("Node.js is required to run packaged compatibility checks")
        plan_file = output / "plan.json"
        plan_file.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
        report["plan"] = plan
        save()
        with (output / "runner.log").open("w", encoding="utf-8") as log:
            result = subprocess.run(
                [node, str(runner), "--plan", str(plan_file), "--output", str(output / "runner")],
                cwd=harness_directory, env=candidate_environment(output),
                stdout=log, stderr=subprocess.STDOUT, check=False,
            )
        report["runnerExitCode"] = result.returncode
        runner_report = read_object(output / "runner" / "report.json")
        expected_status = STATUSES.get(result.returncode)
        if expected_status is None or runner_report.get("status") != expected_status:
            raise ValueError("Runner exit code and report status disagree or are outside the v1 contract")
        report["status"] = expected_status
        report["runnerReport"] = str(output / "runner" / "report.json")
        save()
        return result.returncode
    except CompatibilityFailure as error:
        report["status"] = "failed"
        report["error"] = str(error)
        save()
        return 1
    except (OSError, ValueError, TypeError, EOFError, ET.ParseError, zipfile.BadZipFile, zlib.error, subprocess.SubprocessError) as error:
        report["status"] = "infrastructure-error"
        report["error"] = f"{type(error).__name__}: {error}"
        save()
        return 2


def main():
    """Run against one downloaded Build artifact; a nonzero exit is never a successful check."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-directory", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--inputs-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--preparation-status", default="Succeeded")
    args = parser.parse_args()
    try:
        result = run_report(
            args.candidate_directory.resolve(), args.inputs.resolve(), args.inputs_sha256, args.output.resolve(),
            args.preparation_status,
        )
    except OSError as error:
        print(f"Compatibility infrastructure error: {error}", file=sys.stderr)
        return 2
    if result:
        print(f"Compatibility {STATUSES[result]}; see {args.output / 'adapter-report.json'}", file=sys.stderr)
    return result


if __name__ == "__main__":
    sys.exit(main())
