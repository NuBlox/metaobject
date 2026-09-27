# M77 stable v1 promotion

M77 promotes `@nublox/metaobject` from the published `1.0.0-rc.1` contract to the first stable `1.0.0` release without adding runtime scope.

## Promotion principle

Stable promotion is intentionally narrow. The release changes package/release metadata only:

- root package version `1.0.0-rc.1` → `1.0.0`;
- stable release notes and README status;
- release-readiness evidence.

No core runtime source, public declaration, public API generation, persistence contract, trust format or behavioral semantic is changed by M77.

## Evidence supporting promotion

The published RC has already passed the following independent evidence:

- core Node.js 20, 22 and 24 CI;
- packed clean ESM and TypeScript consumer installation;
- reusable storage and metadata conformance suites;
- M69–M75 implementation of a real external MySQL adapter against the published RC contract;
- adapter clean-consumer qualification on Node.js 22 and 24;
- live MySQL 8.0 and 8.4 conformance, migration, concurrency and M74 stress certification;
- no core runtime or public-declaration correction required by that adapter work.

A repository comparison from `v1.0.0-rc.1` through the M75 boundary found no post-RC changes to core `src/`, `test/` or `type-tests/`. M76 then hardened publication metadata and release automation without changing runtime code.

## Stable compatibility boundary

`METAOBJECT_PUBLIC_API_VERSION === "1"` remains the stable compatibility generation.

The supported import boundary remains the package root:

```ts
import { defineObjectType } from "@nublox/metaobject";
```

Generated `dist/**` deep imports remain internal and are not SemVer compatibility contracts.

## Qualification gate

The exact M77 promotion revision must pass:

- core typecheck/build/test on Node.js 20;
- core typecheck/build/test on Node.js 22;
- core typecheck/build/test on Node.js 24;
- package-manifest and release-metadata verification;
- packed clean-consumer runtime and TypeScript verification;
- MySQL adapter packed-consumer verification on Node.js 22 and 24;
- MySQL 8.0 live persistence/integration/M74 certification;
- MySQL 8.4 live persistence/integration/M74 certification.

The adapter lanes are retained during stable promotion because they are external evidence that the unchanged v1 persistence contracts remain implementable.

## Tag and publication boundary

Passing the branch and merged-`main` gates does not itself publish stable v1.

The irreversible release sequence is:

1. merge the exact green M77 promotion revision to `main`;
2. verify the push-triggered `main` qualification run is green;
3. configure npm trusted publishing for `@nublox/metaobject` against `.github/workflows/publish-metaobject.yml`;
4. create `v1.0.0` from that exact verified `main` commit;
5. allow the tag-triggered trusted-publishing workflow to rerun `release:check` and publish the package;
6. verify the npm registry reports `@nublox/metaobject@1.0.0`, Apache-2.0 and `latest: 1.0.0`.

Do not create `v1.0.0` before trusted publishing is configured unless an explicit manual-release path has been chosen, because the tag triggers the publication workflow.

## `rc.2` escape hatch

If M77 qualification exposes a defect requiring a core runtime/public declaration/compatibility change, stop stable promotion, restore the prerelease line and release `1.0.0-rc.2` instead.

A database-adapter-only defect, documentation correction or release-automation issue does not itself require a new core RC.

## Completion

M77 engineering is complete when the version/changelog-only promotion is merged to `main` and the complete post-merge qualification matrix is green. Stable release completion additionally requires the `v1.0.0` tag, successful npm publication and registry verification.
