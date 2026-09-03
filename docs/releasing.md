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

1. Run the stable Azure Pipelines build defined by
   `build/azure-pipeline.stable.yml`.
2. Select the prepared release branch, for example `release/1.38.0`.
3. Set the **Publish Extension** parameter to `true`.
4. Monitor the build until publishing completes.
5. Verify that the extension is available in the Marketplace and that the
   corresponding GitHub tag and release were created. The stable pipeline
   automatically generates and publishes the GitHub release notes.

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

The branch named in the stable pipeline's `DownloadPipelineArtifact` step, such
as `refs/heads/release/2026.12`, belongs to the external Python environment
tools build. It is separate from this repository's `release/1.<even minor>.0`
branch. Before a stable release, verify that the configured tools branch is the
one intended for that release; update it in a separate pull request when the
tools release changes.
