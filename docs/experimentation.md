# Experimentation infrastructure

The extension owns one internal TAS service per activation. This infrastructure
supports general experimentation and measurement without enabling product features.
Live TAS configuration remains absent until the platform owners approve the endpoint
and identity contract.

## Publisher configuration

`initializeExperimentation()` reads an optional top-level `experimentation` object
from the installed extension's `package.json`. This is publisher-owned metadata,
**not** a VS Code setting: a workspace must not be able to redirect requests that
contain an identifier.

The following is a schema illustration, not deployable configuration. Replace the
placeholders only with reviewed values; do not copy names from legacy `X-*` headers.

```json
{
    "experimentation": {
        "assignmentsEndpoint": "https://<approved-host>/api/v1/assignments",
        "targetPopulation": "public",
        "identityParameter": "<approved-identity-parameter>",
        "assignmentParameters": {
            "<approved-identity-parameter>": "machineId",
            "<approved-extension-version-parameter>": "extensionVersion",
            "<approved-language-parameter>": "language"
        }
    }
}
```

Supported populations are `public`, `insider`, `internal`, and `team`. Select one
explicitly with the owners; an `internal` value is not authentication or proof of
employee status. Version and language bindings are optional. The identity binding
is mandatory and must occur exactly once. Generic SDK parameters cannot be overridden.

The currently implemented identity source is VS Code's public `env.machineId` API.
It must only be used when that is the approved randomization identity. **MachineId
is not DevDeviceId.** If onboarding requires DevDeviceId or another identity, add and
review its provider first; unsupported sources are rejected, not silently substituted.
Ensure the analysis identity, and any future VS Code core setting experiment's
identity, agrees with this contract.

Absent configuration reports `notConfigured` and makes no TAS requests. Invalid
configuration reports an error and also makes no requests; it does not silently
fall back to a legacy-only integration. No endpoint, identity value, or mapping is
accepted from workspace configuration.

## Service lifecycle and queries

The service is initialized after logging is available and is registered in the
extension context's subscriptions. It does not block extension activation on
networking and is not part of the public Python Environments API.

Future extension-owned experiments can use the internal facade:

```typescript
const experiments = getExperimentationService();
await experiments?.initializePromise;
const enabled = experiments?.getTreatmentVariable('approvedFeatureName', false) ?? false;
```

Use constant **bare** names in the `vscode` namespace, not `/vscode/` prefixes or
user-provided strings. Boolean, string, and finite-number defaults are supported.
Missing or wrong-typed values use the caller's default. These are synchronous
snapshot queries, not refresh requests.

- `initializePromise` covers module/cache initialization, with a five-second
  deadline. It is not evidence of a successful server request.
- `initialFetch` covers the first attempt, with a fifteen-second upper bound.
  Completion is not proof of success either; use the endpoint outcomes below.
- A valid warm cache is usable before networking completes. A cold lookup returns
  its default without consuming the SDK's empty snapshot until a fetched snapshot
  is committed. A later request failure does not erase an already usable snapshot.
- The SDK normally polls every thirty minutes. Once a treatment is consumed, its
  ordinary polls persist newer assignments for later sessions rather than replacing
  the consumed in-memory snapshot. The facade does not expose a force-refresh API.
- Consumers still own their feature's startup-versus-dynamic policy. In particular,
  a settings-based experiment should read VS Code's effective setting, not add a
  second TAS Boolean gate.

Cache data lives in `context.globalState`, namespaced by the approved configuration,
identity, and extension version. The namespace is hashed; identifiers and endpoints
are not emitted in diagnostics. This prevents another population, identity, endpoint,
or version from reusing that snapshot. Malformed cache data is ignored with a warning.

Revoking telemetry consent disposes the SDK, aborts outstanding requests, clears
shared attribution, and makes queries use defaults. Re-enabling consent creates a
replacement instance. Old callbacks and new writes from stopped instances are ignored.
Initialization failures are nonfatal and explicitly logged; reload or a consent
transition starts a new attempt. Automated extension-test hosts do not start live TAS.

The current SDK performs a legacy GET **and** the configured assignments POST.
New-endpoint variables take precedence when both return the same name. The common
HTTPS transport supplies cancellation, a ten-second request deadline, and a two-MiB
response cap to both endpoints. It uses Node HTTPS like the SDK, retaining the
extension host's HTTP hooks; proxy behavior must still be verified in the deployment
environments. There is no insecure TLS or redirect fallback.

`tas-client` requires Node 22. TypeScript 5.8 or newer is needed to type-check the
current wrapper's CommonJS-to-ESM declarations without disabling library checking.

## Telemetry and diagnostics

The SDK adapter forwards an allowlist of classified events/properties through the
existing sender. `abexp.assignmentcontext` is shared by normal events, error events,
and SDK events, including automatically captured `unhandlederror` exceptions.
It is copied into each event; per-event data cannot override it.
Raw request headers, audience filters, and identifiers are not forwarded.

Automatic exceptions use an extension-owned VS Code telemetry logger for consent
and data cleaning. The reporter's duplicate automatic collection is disabled using
the SDK's public `ignoreUnhandledErrors` option. The cleaned
exception is labelled at capture time, then forwarded through the reporter's raw
send method with an additional error-consent and lifetime check. This preserves
the existing event name and common properties without bypassing consent or
changing the assignment on events that are already queued.

The reporter exists only within an active registration. Late completions after
disposal cannot recreate it, and an obsolete disposer cannot end a newer registration.

| Signal | Meaning |
| --- | --- |
| `EXPERIMENTATION.INITIALIZATION` | `notConfigured`, `cacheReady`, `error`, or `timeout`, with initialization duration and initial cache presence. Consent-disabled instances are observable locally, not by sending telemetry against that choice. |
| `tas-call` | Independent `legacy` or `assignments` request outcome: `Success`, `ServerError`, `NoResponse`, or `GenericError`. |
| `assignments-validation` | Counts and response data version from the assignments provider. |
| `query-expfeature` | A treatment was queried; this is not proof that a feature was enabled, exposed, or used. |
| `call-tas-error`, `call-assignments-error` | Classified fetch failure categories. |

`service.diagnostics` separates cache readiness/presence, availability of a usable
snapshot, first-attempt completion, and the latest outcomes of each endpoint.
For example, a cached value can remain usable while the latest request reports
`NoResponse`. Output-channel diagnostics do not log treatment values or identities.

Events sent before attribution is available remain unattributed; the sender does
not retroactively label them using a later assignment. Scorecards must account for
this, especially for early startup events. Validate attribution coverage in A/A;
do not assume that every event is assigned just because initialization completed.

## Baseline measurement inventory

Reuse these existing signals before adding new events. Names below are the source
event names; confirm the telemetry ingestion system's normalized names when defining
the scorecard. Only consented, attributed traffic belongs in assignment comparisons.

| Area | Existing events | Candidate baseline measurements and limitations |
| --- | --- | --- |
| Activation | `EXTENSION.ACTIVATION_DURATION` | Activation-duration distribution and activated-device denominator. Emitted on successful return, so it does not count every early activation failure. |
| Async setup | `EXTENSION.MANAGER_REGISTRATION_DURATION`, `SETUP.HANG_DETECTED`, `MANAGER_READY.TIMEOUT` | Setup duration, failure-stage distribution, hangs and readiness timeouts. Async setup is distinct from activation. |
| Discovery | `ENVIRONMENT_DISCOVERY`, `MANAGER.LAZY_INIT`, `PET.INIT_DURATION`, `PET.CONFIGURE`, `PET.REFRESH`, `PET.RESOLVE` | Duration and error/timeout rates by manager/operation. A refresh is not a unique user or environment; cancellation is grouped with timeout in the manager refresh wrapper. |
| Discovery recovery | `PET.PROCESS_RESTART`, `PET.JSON_CLI_FALLBACK`, `GLOBAL_ENV.CACHE` | Restart/fallback rates and cache hits/stale entries, with attempt versus user denominators kept separate. |
| Selection | `ENV_SELECTION.STARTED`, `ENV_SELECTION.RESULT`, `ENV_SELECTION.COMPLETED` | Selection latency, resolution path and coverage, including deferred global work. |
| Package operations | `PACKAGE_MANAGEMENT` | Success/error/cancellation rates and duration by manager and trigger source. A fulfilled manager operation is not independently verified package state. |
| Environment creation | `CREATE_ENVIRONMENT`, `VENV.CREATION` | Entry-point and quick/custom intent counts. These do not prove successful creation, usability, or an end-to-end completion. |
| Base Python installation | `UV.PYTHON_INSTALL_PROMPTED`, `UV.PYTHON_INSTALL_STARTED`, `UV.PYTHON_INSTALL_COMPLETED`, `UV.PYTHON_INSTALL_FAILED` | Prompt/start/completion/failure counts. Define denominators and cancellation semantics before calling this a conversion funnel. |
| Project/environment usage | `ADD_PROJECT`, `PROJECT_STRUCTURE`, `ENVIRONMENT_TOOL_USAGE` | Adoption and workspace-shape context. Startup observations are not retention by themselves. |

Gaps to settle with metric owners:

- An arm-independent, feature-specific exposure/eligibility event for each future
  experiment. General treatment queries are not substitutes for actual exposure.
- A consistent end-to-end environment-creation outcome and duration. Existing intent
  events cannot be treated as successful creations.
- An agreed activated/eligible-device or session denominator, retention window,
  cancellation policy, and attribution-coverage threshold.
- Coverage for failures before successful activation and for user flows spanning
  multiple components. Any new correlation data needs privacy review.

This inventory preserves existing event semantics.

## Validation and external onboarding

Unit tests use a fake SDK for lifecycle cases. A separate contract test loads the
installed SDK with a fake transport to verify dual requests, assignment merging,
bare variable names, and shared attribution without contacting TAS.

Before live use, confirm the endpoint, identity names/source, audience/population,
ExP workspace, access, and scorecard with the VS Code experimentation owners. Obtain the integration and
metrics reviews described in the onboarding guidance. An A/A can validate allocation,
attribution, data quality and baseline stability without exposing a new setting or
changing product behavior. A real `tas-call` with `callType = assignments` and
`outcome = Success`, a known new-endpoint assignment, and tagged subsequent telemetry
must all agree; a cached value alone is not proof that onboarding works.

Some older checklists still require `vscode.abexp.features`; the current SDK no
longer maintains it. Use the current assignment-context guidance instead. The
documented CodeExpOwners mail alias has been reported unavailable; confirm the
current onboarding and review contacts with the platform owners.

- [Extension onboarding](https://dev.azure.com/devdiv/DevDiv/_wiki/wikis/DevDiv.wiki/23415/Onboard-a-VS-Code-extension)
- [Current TAS integration guidance](https://dev.azure.com/devdiv/DevDiv/_wiki/wikis/DevDiv.wiki/23416/Step-1a-Integrate-TAS)
