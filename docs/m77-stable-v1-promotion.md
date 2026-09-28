# M77 stable v1 promotion

M77 promotes `@nublox/metaobject` from the published `1.0.0-rc.1` contract to the first stable `1.0.0` release without adding runtime scope.

## Promotion principle

Stable promotion is intentionally narrow. The release changes package/release metadata only:

- root package version `1.0.0-rc.1` → `1.0.0`;
- stable release notes and README status;
- release-readiness evidence.

No core runtime source, public declaration, public API generation, persistence contract, trust format or behavioral semantic is changed by M77.

## Evidence supporting promotion

The published RC passed the following independent evidence before stable promotion:

- core Node.js 20, 22 and 24 CI;
- packed clean ESM and TypeScript consumer installation;
- reusable storage and metadata conformance suites;
- M69–M75 implementation of a real external MySQL adapter against the published RC contract;
- adapter clean-consumer qualification on Node.js 22 and 24;
- live MySQL 8.0 and 8.4 conformance, migration, concurrency and M74 stress certification;
- no core runtime or public-declaration correction required by that adapter work.

A repository comparison from `v1.0.0-rc.1` through the M75 boundary found no post-RC changes to core `src/`, `test/` or `type-tests/`. M76 then hardened publication metadata and release automation without changing runtime code.

The final release-automation-only commit `41a5f78c670ef9845fd19c12c8d9610d3da344c5` made MySQL-adapter prerelease tagging explicit and also left the core runtime/public declarations unchanged. The `v1.0.0` tag resolves exactly to that commit.

## Stable compatibility boundary

`METAOBJECT_PUBLIC_API_VERSION === "1"` remains the stable compatibility generation.

The supported import boundary remains the package root:

```ts
import { defineObjectType } from "@nublox/metaobject";
```

Generated `dist/**` deep imports remain internal and are not SemVer compatibility contracts.

## Qualification gate

The M77 promotion passed:

- core typecheck/build/test on Node.js 20;
- core typecheck/build/test on Node.js 22;
- core typecheck/build/test on Node.js 24;
- package-manifest and release-metadata verification;
- packed clean-consumer runtime and TypeScript verification;
- MySQL adapter packed-consumer verification on Node.js 22 and 24;
- MySQL 8.0 live persistence/integration/M74 certification;
- MySQL 8.4 live persistence/integration/M74 certification.

The adapter lanes were retained during stable promotion because they are external evidence that the unchanged v1 persistence contracts remain implementable.

## Tag and publication evidence

The irreversible release sequence completed successfully:

1. the stable `1.0.0` promotion was merged to `main` and passed the complete qualification matrix;
2. npm trusted publishing was configured for `@nublox/metaobject` against `.github/workflows/publish-metaobject.yml`;
3. the annotated `v1.0.0` tag was created and pushed, resolving to commit `41a5f78c670ef9845fd19c12c8d9610d3da344c5`;
4. GitHub Actions workflow run `36362303649` verified tag/version/main ancestry and reran the complete release gate;
5. the workflow passed all 384 core tests, package verification and clean external-consumer verification;
6. trusted publishing published `@nublox/metaobject@1.0.0` under the `latest` dist-tag;
7. npm emitted and published a GitHub Actions provenance statement to the Sigstore transparency log.

## `rc.2` escape hatch

M77 did not expose a defect requiring a core runtime/public declaration/compatibility change, so `1.0.0-rc.2` was not required.

A database-adapter-only defect, documentation correction or release-automation issue does not itself require a new core RC.

## Completion

M77 is complete. Stable v1 is tagged as `v1.0.0` and published as `@nublox/metaobject@1.0.0` through npm trusted publishing with provenance, after the complete release gate passed on the exact tagged commit.
