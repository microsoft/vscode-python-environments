# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Prepare immutable inputs for opt-in draft CI, not a production release dependency."""

import argparse
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
import zlib

from report import SEMVER, SHA256, extract_archive, inspect_vsix, pinned_partner, read_object, require_hash, sha256


COMMIT = re.compile(r"[0-9a-f]{40}")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/vscode-python")
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024


def read_config(file):
    """Validate the explicit draft scope and immutable public harness/companion references."""
    config = read_object(file)
    if type(config.get("schemaVersion")) is not int or config["schemaVersion"] != 1 or config.get("purpose") != "draft-ci-verification":
        raise ValueError("Expected draft-ci-verification schemaVersion 1")
    number = config.get("draftPullRequest")
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise ValueError("draftPullRequest must explicitly identify one draft PR")
    if not isinstance(config.get("vscodeVersion"), str) or not SEMVER.fullmatch(config["vscodeVersion"]):
        raise ValueError("vscodeVersion must pin an exact stable release")
    harness = config.get("harness")
    if (
        not isinstance(harness, dict)
        or not isinstance(harness.get("repository"), str)
        or not REPOSITORY.fullmatch(harness["repository"])
        or not isinstance(harness.get("commit"), str)
        or not COMMIT.fullmatch(harness["commit"])
        or not isinstance(harness.get("repositoryLockSha256"), str)
        or not SHA256.fullmatch(harness["repositoryLockSha256"])
    ):
        raise ValueError("Harness repository and reviewed immutable 40-character commit are required")
    for name, extension in (("core", "python"), ("upgradeFromEnvironments", "vscode-python-envs")):
        artifact = config.get(name)
        if not isinstance(artifact, dict) or not isinstance(artifact.get("version"), str):
            raise ValueError(f"Missing pinned {name}")
        version = artifact["version"]
        if not SEMVER.fullmatch(version) or not isinstance(artifact.get("sha256"), str) or not SHA256.fullmatch(artifact["sha256"]):
            raise ValueError(f"{name} must pin an exact released version and SHA-256")
        expected = (
            "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-python/"
            f"vsextensions/{extension}/{version}/vspackage?targetPlatform=win32-x64"
        )
        if artifact.get("downloadUrl") != expected:
            raise ValueError(f"{name} must use its exact Windows x64 Marketplace version asset")
    return config


def describe(config, pull_request, draft):
    """Select only the configured draft; an unrequested case is not a compatibility pass."""
    enabled = draft and pull_request == config["draftPullRequest"]
    values = {
        "enabled": str(enabled).lower(),
        "harness_repository": config["harness"]["repository"],
        "harness_commit": config["harness"]["commit"],
    }
    if "GITHUB_OUTPUT" in os.environ:
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
            for key, value in values.items():
                output.write(f"{key}={value}\n")
    return {"scope": "draft-ci-verification", "requested": enabled, **values}


def verify_snapshot(directory, repository, commit):
    """Require the checked-out, unmodified tracked source to match the declared repository/SHA."""
    if not COMMIT.fullmatch(commit):
        raise ValueError("Source provenance requires an immutable commit")

    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=directory, check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()

    if git("rev-parse", "HEAD") != commit:
        raise ValueError(f"Checked-out source does not match the pinned commit for {repository}")
    origin = git("remote", "get-url", "origin").removesuffix(".git").casefold()
    if origin != f"https://github.com/{repository}".casefold():
        raise ValueError(f"Checked-out repository does not match {repository}")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise ValueError(f"Tracked source changed during preparation: {repository}")


def download_partner(artifact, destination):
    """Decode supported HTTP transport and verify the original, unmodified VSIX bytes."""
    with urllib.request.urlopen(artifact["downloadUrl"], timeout=60) as source, destination.open("xb") as output:
        encoding = source.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding not in ("", "identity", "gzip"):
            raise ValueError(f"Unsupported partner HTTP Content-Encoding: {encoding}")

        def copy(stream):
            size = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    raise ValueError("Decoded partner VSIX exceeds the download size limit")
                output.write(chunk)

        if encoding == "gzip":
            with gzip.GzipFile(fileobj=source, mode="rb") as decoded:
                copy(decoded)
        else:
            copy(source)
    require_hash(destination, artifact["sha256"])


def verify_harness(file):
    """Verify every file in the self-contained producer manifest, outside any source checkout."""
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary) / "harness"
        extract_archive(file, directory)
        manifest = read_object(directory / "harness-manifest.json")
        if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1 or not isinstance(manifest.get("files"), list):
            raise ValueError("Invalid self-contained harness manifest")
        actual = {
            entry.relative_to(directory).as_posix()
            for entry in directory.rglob("*") if entry.is_file()
        }
        expected = set()
        for entry in manifest["files"]:
            name = entry.get("path") if isinstance(entry, dict) else None
            if not isinstance(name, str) or name in expected:
                raise ValueError("Invalid or duplicate harness manifest path")
            file_path = (directory / name).resolve()
            if not file_path.is_relative_to(directory.resolve()) or not file_path.is_file():
                raise ValueError("Harness manifest file is outside the distribution or missing")
            require_hash(file_path, entry.get("sha256"))
            expected.add(name)
        if actual != expected | {"harness-manifest.json"}:
            raise ValueError("Harness files and its manifest disagree")
        for required in ("run.js", "checks.js", "process.ps1", "controller/index.js",
                         "node_modules/@vscode/test-electron/package.json"):
            if required not in expected:
                raise ValueError(f"Self-contained harness is missing {required}")
        return manifest


def prepare(config, source_root, source_repository, source_head, harness_root, candidate, harness_zip, output):
    """Freeze a normally packaged candidate, reviewed harness and released companions for a clean job."""
    verify_snapshot(source_root, source_repository, source_head)
    verify_snapshot(harness_root, config["harness"]["repository"], config["harness"]["commit"])
    identity = inspect_vsix(candidate, "vscode-python-envs")
    if identity["targetPlatform"] != "win32-x64" or identity["petFiles"]:
        raise ValueError("The draft candidate must be a normally packaged no-PET win32-x64 VSIX")
    if read_object(source_root / "package.json").get("version") != identity["version"]:
        raise ValueError("Candidate version does not match the checked-out source")
    manifest = verify_harness(harness_zip)
    lock_sha = sha256(harness_root / "package-lock.json")
    if manifest.get("repositoryLockSha256") != lock_sha or config["harness"]["repositoryLockSha256"].lower() != lock_sha:
        raise ValueError("Harness distribution does not match the pinned source lockfile")
    output.mkdir(parents=True)
    (output / "candidate").mkdir()
    shutil.copyfile(candidate, output / "candidate" / "environments.vsix")
    require_hash(output / "candidate" / "environments.vsix", identity["sha256"])
    (output / "adapter").mkdir()
    driver = output / "adapter" / "report.py"
    shutil.copyfile(source_root / "build" / "releaseCompatibility" / "report.py", driver)
    provenance = {
        "schemaVersion": 1, "scope": "draft-ci-unsigned-source-head", "runtimeValidated": False,
        "source": {"repository": source_repository, "commit": source_head},
        "candidate": identity,
        "harness": {**config["harness"], "sha256": sha256(harness_zip), "repositoryLockSha256": lock_sha},
        "vscodeVersion": config["vscodeVersion"], "driverSha256": sha256(driver),
        "ci": {"runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT")},
    }
    with tempfile.TemporaryDirectory() as temporary:
        partners = Path(temporary)
        inputs = {
            "schemaVersion": 1, "vscodeVersion": config["vscodeVersion"],
            "harness": {"path": "harness.zip", "sha256": provenance["harness"]["sha256"]},
        }
        for name, filename, extension in (
            ("core", "python.vsix", "python"),
            ("upgradeFromEnvironments", "environments-baseline.vsix", "vscode-python-envs"),
        ):
            artifact = config[name]
            download_partner(artifact, partners / filename)
            pinned = {
                "path": filename, "version": artifact["version"], "sha256": artifact["sha256"],
                "provenance": {"downloadUrl": artifact["downloadUrl"]},
            }
            pinned_partner({name: pinned}, name, partners, extension)
            if name == "upgradeFromEnvironments":
                pinned["pet"] = "bundled"
            inputs[name] = pinned
        bundle = output / "inputs.zip"
        with zipfile.ZipFile(bundle, "x", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("inputs.json", json.dumps(inputs, indent=2) + "\n")
            archive.writestr("provenance.json", json.dumps(provenance, indent=2) + "\n")
            for name in ("core", "upgradeFromEnvironments"):
                archive.write(partners / inputs[name]["path"], inputs[name]["path"])
            archive.write(harness_zip, "harness.zip")
    provenance["inputsSha256"] = sha256(bundle)
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    if "GITHUB_OUTPUT" in os.environ:
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
            stream.write(f"inputs_sha256={provenance['inputsSha256']}\n")
            stream.write(f"driver_sha256={provenance['driverSha256']}\n")
            stream.write(f"candidate_sha256={identity['sha256']}\n")
    return provenance


def main():
    """Report preparation errors explicitly; never convert absent pins/artifacts into a pass."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("describe", "prepare"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--pull-request", type=int, default=0)
    parser.add_argument("--draft", choices=("true", "false"), default="false")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--source-repository")
    parser.add_argument("--source-head")
    parser.add_argument("--harness-root", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--harness", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        if args.action == "describe":
            result = describe(config, args.pull_request, args.draft == "true")
        else:
            if any(value is None for value in (args.source_root, args.source_repository, args.source_head,
                                               args.harness_root, args.candidate, args.harness, args.output)):
                raise ValueError("prepare requires source/harness snapshots, candidate, distribution and new output")
            result = prepare(
                config, args.source_root.resolve(), args.source_repository, args.source_head,
                args.harness_root.resolve(), args.candidate.resolve(), args.harness.resolve(), args.output.resolve(),
            )
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, TypeError, EOFError, zlib.error, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Draft compatibility infrastructure error: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
