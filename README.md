# IncidentLens — source review export

Prepared 2026-10-18 from extension manifest version `0.3.26-rc.2`.
This is a source-only snapshot, not a standalone application or a deployable release. The author authorized publication of this extension source. No license has been selected or included; public visibility does not itself grant a license.

## What is included

IncidentLens provides reporter capture and progress views, AI-assisted report assessment, control-room grouping and incident management, agency assignments, and situation briefs. The extension contains a .NET backend, an Angular Native Federation remote, and host agent skills. AI assessments are advisory: photographs do not establish truth, and app assignments or notifications do not mean emergency services have been dispatched.

`backend/` contains resource models, services and controllers. `frontend/src/` contains all three role experiences. `manifest.json` describes host registrations. `skills/` contains assessment and brief workflows. `tests/` contains two offline, synthetic logic test suites. This export is the full extension source; it is not the separate reporter-only demo.

## Required host and private dependencies

A compatible DuploCloud AI Helpdesk host is required for authentication, authorization, workspace resources, Mongo-backed persistence, extension registration, task execution, model routing and frontend shell services. The host application and its custom patches are not included.

- Backend: .NET 8 and an authorized copy of `Duplocloud.AiHelpdesk.Sdk` matching the running host. The snapshot manifest names SDK `1.0.6`; query your own host's `/v1/aiservicedesk/extensions/sdk-version` and obtain its authorized `/sdk-bundle`. The project uses a compile-only SDK reference. `backend/nuget.config` points to an intentionally absent local `sdk-packages/` directory and public NuGet.
- Frontend: compatible Node tooling, Angular 22, and an authorized copy of the private `@duplocloud-internal/ng-common-lib` package. `package.json` and the lockfile retain the required local `vendor/duplocloud-internal-ng-common-lib-0.3.0.tgz` reference to make the dependency explicit. That tarball is deliberately absent. Do not substitute or redistribute it without permission.
- The remote's shared packages must match the host's federation configuration. Browser camera, microphone and location use also depends on HTTPS, browser consent and host response headers.
- Skills require the host agent execution context, scoped resource credentials, Bash, Python 3, jq and curl. Do not run workflow entry points against live incidents as a smoke test: they can write resource status/results and invoke external services.

Once authorized private prerequisites are supplied, the usual build commands are `npm ci` and `npm run build` in `frontend/`, and `dotnet publish -c Release -p:DuploSdkVersion=<HOST_SDK_VERSION> -o <OUTPUT_DIRECTORY>` in `backend/`. These are prerequisite guidance, not verified standalone build instructions. No dependency installation, build, registration or deployment was performed for this export.

## Configuration and Google integrations

`config.example.json` is documentation only; no application loader reads it. It contains placeholders, not credentials. Configure the host's scoped credentials and model routing separately using its supported administration flow. Never commit tokens, cloud service-account files or real incident data.

The source implements a Google Cloud Vision assessment helper, Google Maps/Places-related support, and host-agent assessment/brief workflows. Model selection and Gemini/Vertex routing belong to host configuration, not this source export. The source alone does not prove any cloud service is configured or a specific model invocation succeeds. Separate validation of the deployment is required. Brief workflows include an explicit simulated mode; simulated results must remain labelled.

`frontend/src/app/shared/maps-key.ts` intentionally has an empty browser-key placeholder. An authorized build process must supply an appropriately restricted browser key for Maps functionality. A browser key becomes visible in the built bundle; generated outputs must not be added to this source repository. The original local build script and deployment configuration are omitted.

## Offline synthetic tests

The selected tests use fabricated report identifiers, categories, coordinates and an `example.com` email address. They contain no actual incident records or evidence and make no network calls. With Node 26 (used for export validation), run from this directory:

```sh
node tests/grouping_logic.test.mjs
node tests/search_logic.test.mjs
```

These checks cover grouping prefill/selection and search behavior. They do not validate backend authorization, end-to-end workflows, cloud integrations or production readiness.

## Current limitations

- A clean public checkout cannot build or run independently while private host prerequisites are unavailable.
- Reporter UI filtering is not proof of backend privacy. Source includes scoped evidence/cleanup controls, but generic host ticket, transcript and evidence access must still receive an end-to-end authorization review. This export makes no real-data safety claim.
- Agent work depends on host scheduling; durable execution and recovery are not established by this export.
- AI uncertainty, duplicate grouping and dispatch decisions require human review. No connection to real emergency dispatch is established here.
- Deployment-specific UI confinement, login and browser permissions changes live in the private host repository and are excluded.
- No production credentials, real evidence, screenshots, operational results or historical release archives are provided.

## Export boundary and publication decisions

The export excludes parent Git history, host source, private packages, downloaded SDKs, dependency trees, build/cache output, local configuration, operational scripts, rollback archives and recorded tests/evidence. The supplied `.gitignore` is defense in depth; inspect and scan the exact staged contents before any publication.

Publication destination: `omgupta-duplo/incidentlens`, authorized by the author. Licensing and applicable third-party notices remain to be resolved, as does how authorized consumers obtain private dependencies. No license was copied from the parent checkout because its applicability to this extension has not been established. Existing source comments and package metadata are preserved; private host packages are not redistributed.
