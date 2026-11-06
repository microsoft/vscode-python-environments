# Release process

Python Environments uses even minor versions for stable releases and odd minor
versions for pre-release development. For example, `1.38.0` is a stable release
and `1.39.0` starts the next pre-release cycle.

## Prepare the release branch

Complete these steps before release day:

1. Change the version in `package.json` to the next even minor version, for
   example `1.38.0`.
2. Run `npm i` to update `package-lock.json`.
3. Create and merge a pull request against `main`.
4. Create the release branch from the updated `main` branch. Name it
   `release/1.<even minor>.0`, for example `release/1.38.0`, and push it to the
   upstream repository.
5. Change the version in `package.json` to the next odd minor version, for
   example `1.39.0`.
6. Run `npm i` to update `package-lock.json`.
7. Create and merge a second pull request against `main`. Do not merge this
   change into the release branch.

The release branch must therefore retain the even version while `main` moves
back to an odd pre-release version.

## Publish on release day

1. Run the DevDiv stable Azure Pipelines build defined by
   `build/azure-devdiv-pipeline.stable.yml`.
2. Select the prepared release branch, for example `release/1.38.0`.
3. Set the **Publish Extension** parameter to `true`.
4. Monitor the build until publishing completes.
5. Verify that the extension is available in the Marketplace and that the
   corresponding GitHub tag and release were created. The stable pipeline
   automatically generates and publishes the GitHub release notes.

The DevDiv pre-release definition is
`build/azure-devdiv-pipeline.pre-release.yml`. The older Monaco definitions,
`build/azure-pipeline.stable.yml` and `build/azure-pipeline.pre-release.yml`,
remain in the repository; this documentation does not disable or redirect them.
Check the selected pipeline definition before queueing a release. The DevDiv
stable pipeline retains its existing manual validation gate, and these changes
do not change either pipeline's publication parameter defaults.

## Publish a point release

Use the existing release branch for a patch to a stable release. For example,
release `1.38.1` from `release/1.38.0`; do not create a
`release/1.38.1` branch.

1. Change the version in `package.json` to the new patch version, for example
   `1.38.1`.
2. Run `npm i` to update `package-lock.json`.
3. Create and merge a pull request against the existing release branch, for
   example `release/1.38.0`.
4. On release day, run the stable Azure Pipelines build from that release
   branch with **Publish Extension** set to `true`.
5. Verify the Marketplace publication and the automatically generated GitHub
   tag and release notes for the point release.

Do not change the version on `main` as part of the point release. It should
remain on the odd minor version for the current pre-release development cycle.

## Python environment tools dependency

The DevDiv packaging steps intentionally do not download or bundle Python
Environment Tools (PET). At runtime, Environments uses its own
`python-env-tools/bin/pet` (`pet.exe` on Windows) if present, otherwise the copy
in the installed Python extension. This is the existing fallback contract, not
a new hard extension dependency or a newly imposed minimum Python extension
version. Verify the actual installed partner instead of assuming it contains a
compatible binary.

The Monaco stable pipeline still downloads PET from the external tools build,
using a branch such as `refs/heads/release/2026.12`. That branch is separate from
this repository's `release/1.<even minor>.0` branch. Its configuration matters
when using Monaco, not when checking the DevDiv omission/fallback path. Existing
Marketplace releases can still bundle PET; do not describe all shipped
Environments packages as PET-free.

## Packaged compatibility report (opt-in)

### Read-only draft verification

The PR workflow also has a bounded, opt-in installed-artifact check on a clean
Windows x64 runner. Its explicit draft PR number, exact VS Code/released partner
versions and hashes, and reviewed immutable harness repository/commit/lock hash
are recorded in `build/releaseCompatibility/draft-inputs.json`. A nonmatching PR
or a non-draft does not request this check; that is not a compatibility pass.
Moving branches, absent pins and a changed source lock are rejected.

The preparation job checks out the **exact PR head**, normally packages a
Windows x64 VSIX, and separately checks out the reviewed harness snapshot. It
uses the harness producer and existing lock, not a copied implementation or a
floating source ref. Its public dependencies are restored without install
lifecycle scripts. The source snapshots must remain tracked-clean. Candidate,
input ZIP, driver and harness hashes plus source provenance are retained.
The execution job consumes the producer's immutable artifact ID, so a failed-job
retry still uses the original prepared bytes rather than a new attempt's name.

A separate clean Windows job downloads only those same-run artifacts, checks
the candidate/driver/input hashes and invokes the real `report.py`. Products
are installed from the frozen VSIXes; only the independent controller is a
development extension. Raw host logs, requested/effective modes, exact Python
execution outputs, PET/backend evidence and before/after-upgrade results are
preserved even when the job fails. Neither job has signing/publication
credentials or write permissions. Candidate execution restores no dependencies
and uses no source checkout. The verification fixture's reviewed harness pin
is **not** a production/runtime dependency or a release pipeline default.

Upgrade phases require ordinary isolated windows and graceful shutdown:
`--extensionTestsPath` makes VS Code 1.110 use in-memory storage even with a
stable profile path. A controller-owned global/workspace Memento nonce must
survive restart before the product's saved selection is read, without reseeding
it. A broken storage control is infrastructure failure, not a product regression.

This unsigned source-head check does not establish DevDiv template expansion,
detached-signature validity or identity with final signed publication bytes.
Do not convert a retained baseline error into a claim of an error-free baseline.

### DevDiv report-only stage

Both DevDiv definitions accept **runPackagedCompatibility** (default `false`).
When enabled, the graph is:

- Stable: Build -> PackagedCompatibility -> existing manual validation -> Publish.
- Pre-release: Build -> PackagedCompatibility -> Publish.

This is a **pre-sign, report-only Windows x64 check**, not release certification.
The job consumes the original current-run `vsix-win32-x64` Build artifact. It
does not rebuild the extension, install product source as a development
extension, add PET to the VSIX, sign anything, or publish anything. It rejects a
DevDiv candidate that unexpectedly bundles PET.

Supply **compatibilityInputsPipelineId**, **compatibilityInputsBuildId**, and
**compatibilityInputsSha256** from one reviewed input set. The first two identify
an exact run in the same DevDiv project; no `latest` lookup is used. That run
must expose pipeline artifact `python-compatibility-inputs` containing
`inputs.zip`. The last parameter is the SHA-256 of that exact ZIP. An enabled
check with absent, malformed, mismatched, or inaccessible inputs is an explicit
infrastructure error, never a skipped/passing compatibility result.

### Prepare one immutable input set

Resolve the supported released Python partner, released PET-bundling
Environments upgrade baseline, and VS Code version once. Check their package
identities and supported VS Code engines. Keep their exact download URLs and
hashes with the run's evidence; do not independently resolve a moving release in
each job. This is one candidate/released-partner pair plus one upgrade baseline,
not an all-version or all-manager matrix.

The ZIP contains `inputs.json`, both released Windows x64 VSIXes, and a reviewed,
self-contained shared harness ZIP. The adapter checks both manifests agree on
identity/version and that every VSIX targets `win32-x64`. Paths in `inputs.json`
are relative to the input ZIP's root. Use ordinary stored/deflated ZIP entries.
The following is the shape, with placeholders to replace before use:

```json
{
  "schemaVersion": 1,
  "vscodeVersion": "<exact stable major.minor.patch>",
  "core": {
    "path": "python.vsix",
    "version": "<exact released version>",
    "sha256": "<64 hex digits>",
    "provenance": { "downloadUrl": "<exact asset URL>" }
  },
  "upgradeFromEnvironments": {
    "path": "environments-baseline.vsix",
    "version": "<exact released version>",
    "sha256": "<64 hex digits>",
    "pet": "bundled",
    "provenance": { "downloadUrl": "<exact asset URL>" }
  },
  "harness": {
    "path": "harness.zip",
    "sha256": "<64 hex digits>"
  }
}
```

The shared harness is maintained with Python's packaged compatibility tests.
There is deliberately no runtime dependency on an unmerged PR, a personal fork,
or floating `main`. An approved harness distribution must contain `run.js` at
its root, its independent test-controller extension, and all required runtime
dependencies. This adapter does not fetch source or restore npm dependencies.
Record the reviewed harness revision with the input run. The whole harness ZIP,
not just its entry point, is hash-checked before execution.

The runner v1 interface is `node <harness-directory>/run.js --plan <plan.json>
--output <new-directory>`. The adapter creates a plan with exact local artifact
paths, versions and hashes, `candidate: "environments"`, candidate `pet: "omitted"`,
the pinned upgrade baseline, an exact VS Code version, and the fixture Python
executable. The runner must:

- Seed explicit `python.useEnvironmentsExtension: true` and `false` before
  activation in separate processes/profiles; assert requested and effective
  values without changing production defaults.
- Discover the two real fixture venvs, select and switch between them, invoke
  Python's normal `python.execInTerminal` command, and assert the resulting
  process's `sys.executable` and `sys.prefix`. Discovery counts or terminal
  creation alone are not sufficient.
- Start with the released PET-bundling Environments package, shut down the host,
  install the unmodified candidate, and relaunch with the same profile,
  workspace and persisted selection. Check the association and explicit-off
  preference survive; do not reseed them to conceal an upgrade regression.
- For the enabled Environments path, observe the actual `Starting Python Locator
  ... server` log, verify the path belongs to the expected installed extension,
  and match the binary hash to the pinned VSIX contents. Explicit-off may use
  the released core's JavaScript locators: require positive legacy-backend
  evidence and report PET as not started, rather than inventing a PET identity
  or forcing a native experiment. Both paths still require real discovery,
  selection and execution assertions. Optional PET `info` metadata can be
  unknown; an observed native supplier's identity cannot.

The job does not use a signing plugin, a publication service connection, a
release-job context, or persisted checkout credentials. The adapter starts the
runner with an allowlisted environment and an isolated home/temp directory,
without inherited access tokens, Node injection options or Python search-path
overrides. Use an approved isolated disposable agent, not a developer profile or
a signing/publication agent; environment filtering is not an OS security sandbox.

### Read the result and remaining acceptance

Download `packaged-compatibility-win32-x64`. `adapter-report.json` records the
pre-sign scope, candidate hash/version/PET contents, immutable input/harness
hashes, and the exact generated plan. The runner retains `report.json`, raw host
logs and interpreter/PET observations. Its statuses and exit codes are
`passed`/0, `failed`/1, and `infrastructure-error`/2; absent reports or disagreement
between exit code and status are infrastructure errors. Input provenance is
preserved when supplied, never fabricated.

Failures are visible as errors/warnings and saved evidence, but are deliberately
not publication gates yet. A failed report job does not bypass a failed Build,
a canceled run, or the stable manual approval. With the opt-in disabled the
existing release flow is unchanged. The adapter's unit tests use inert fixture
VSIXes and a mocked runner; passing them does **not** certify installed products,
an upgrade, or a hosted pipeline run.

The inspected shared DevDiv template performs signing in its later Publish
stage, emits artifact `extension`, and then publishes it. It copies the Build
VSIX and generates detached signature files, but exposes no isolated
post-Sign/pre-Publish compatibility hook. Consequently this report explicitly
sets `finalSignedArtifactValidated: false`. Before promoting it to final-artifact
acceptance, add an approved shared-template hook after Sign in a separate
non-privileged job, reconcile the tested VSIX hash with the exact signed artifact
used by Publish, verify its detached signature, and execute the installed-VSIX
and upgrade scenarios there. Do not rebuild/restamp packages to obtain a passing
result. Template expansion, input-artifact permissions, runtime observations,
and stable/prerelease ordering still require an actual non-publishing hosted
acceptance run; YAML and unit checks alone do not prove them.

### Opt-out shutdown regression

Installed-pair validation exposed an existing shutdown bug: VS Code invokes
`deactivate()` without an argument, but the extension previously required an
`ExtensionContext` and read its subscriptions unconditionally. The entry point
now retains the activation subscriptions and disposes them once through the
zero-argument callback, including after skipped or partially failed activation.
All captured cleanup is awaited even when a disposer fails; failures are
logged and the first is propagated rather than silently discarded. The owned
batch is detached before cleanup, so shutdown does not dispose it twice or
erase late registrations that still belong to VS Code's context owner.
Concurrent shutdown callbacks await the same in-flight promise and receive the
same failure if cleanup rejects. The output channel/logger remains available
through resource cleanup and error reporting, then is disposed last.
Explicit opt-out still skips activation; this fix changes neither defaults nor
saved settings. Released upgrade baselines remain unmodified, with any observed
shutdown error retained in their evidence.
