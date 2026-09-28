# Release-candidate readiness

This document records the completed first-v1 release-candidate gate and the promotion of `@nublox/metaobject` to stable v1.

## Current position

M62–M68 are complete and `@nublox/metaobject@1.0.0-rc.1` was tagged and published on npm under `next` with Apache-2.0 licensing and copyright held by Stephen J T Spittal.

M69–M75 exercised the published core contract through the independent MySQL storage adapter without requiring a core public-API or runtime correction. The adapter passed packed clean-consumer verification on Node.js 22/24 and full live persistence/certification on MySQL 8.0 and 8.4.

M76 hardened package publication metadata, `prepublishOnly` verification and OIDC-ready trusted-publishing workflows. Comparing `v1.0.0-rc.1` with the M75 boundary showed no changes under core `src/`, `test/` or `type-tests/`; M76 likewise introduced no core runtime or declaration change. There was therefore no technical evidence requiring `1.0.0-rc.2`.

M77 promoted the repository package version/changelog/README to stable `1.0.0` while deliberately leaving runtime source and public declarations untouched. The exact promotion revision passed the complete eight-lane branch qualification and then passed the complete eight-lane push-triggered `main` qualification. A subsequent release-automation-only commit `41a5f78c670ef9845fd19c12c8d9610d3da344c5` made MySQL-adapter prerelease tagging explicit without changing the core package. The annotated `v1.0.0` tag resolves to that commit. The tag-triggered trusted-publishing workflow reran the full release gate, including all 384 core tests and clean-consumer verification, and successfully published `@nublox/metaobject@1.0.0` to npm under `latest` with GitHub Actions provenance.

## Completed RC milestones

### M62 — Trust-root chain verification ✅

- verifies M59 snapshot digests, M60 governance replay and M61 rotation replay as one authority chain;
- deterministically resolves exactly one active authoritative root;
- rejects forks, merges, cycles, incomplete rotations, missing exact governance links, digest mismatches, multiple active roots and disconnected completed rotation islands;
- returns the complete oldest-to-current authority lineage without rewriting historical evidence.

### M63 — Public API stabilization ✅

- establishes the package root as the supported v1 compatibility boundary;
- documents the supported API categories and deep-import policy;
- defines the public error hierarchy and message-stability expectations;
- adds `METAOBJECT_PUBLIC_API_VERSION` as an explicit compatibility-generation marker;
- adds compile-time consumer-contract tests;
- documents v1 semantic compatibility rules and RC-period change discipline.

### M64 — Storage/adapter conformance ✅

- exports reusable `StorageAdapter` and `MetadataStore` conformance runners;
- verifies the in-memory reference implementations against the same contract external adapters must satisfy;
- covers detached reads, optimistic concurrency, atomic batch rollback, request-order results, portable query semantics, filtering and deletion behavior;
- keeps database drivers and dialect-specific dependencies outside core.

### M65 — Release engineering ✅

- verifies npm package contents;
- installs the generated tarball into a clean consumer and validates ESM and TypeScript root imports;
- explicitly tests Node.js 20, 22 and 24;
- establishes changelog/release-note and release procedures.

### M66 — Documentation convergence ✅

- README and architecture documentation match the implemented package;
- documentation is indexed by architectural concern;
- end-to-end examples cover metadata, modules, runtime control, trust, adapters and release verification;
- stability, extension-point and package-boundary expectations are documented.

### M67 — Adversarial hardening ✅

- audits malformed-input, replay and tamper coverage across persistence, journals, portable evidence and trust formats;
- adds an RC adversarial matrix for M59–M62;
- hardens M60 governance and M61 rotation replay against backward timestamp regression;
- preserves fail-closed behavior for unsupported formats, broken revisions/stages, frozen identity mutation, graph ambiguity and digest mismatch.

### M68 — `v1.0.0-rc.1` ✅

- feature scope frozen at M67;
- package version set to `1.0.0-rc.1`;
- package licensed under Apache-2.0 with `LICENSE` and `NOTICE` in the distributable payload;
- complete Node 20/22/24 plus package/consumer release gate passed;
- exact release tag created and package published to npm under `next`.

## Stable-v1 promotion gate

`@nublox/metaobject@1.0.0` completed every stable-promotion requirement:

- [x] the v1 public API boundary remains generation `"1"`;
- [x] no known fail-open trust, lifecycle, concurrency or persistence defect remains;
- [x] clean package consumers remain green;
- [x] supported Node.js 20/22/24 checks remain green;
- [x] the published RC was exercised by an independent database adapter without requiring a core contract change;
- [x] MySQL 8.0/8.4 qualification demonstrated the persistence contracts are externally implementable;
- [x] post-RC development did not alter core runtime source or public declarations;
- [x] release publication is protected by pre-publish verification and canonical repository metadata;
- [x] the M77 `1.0.0` promotion passed the complete branch and merged-`main` qualification matrix;
- [x] npm trusted publishing is configured for `@nublox/metaobject` against `publish-metaobject.yml`;
- [x] the exact `v1.0.0` tag was created from the verified green release commit `41a5f78c670ef9845fd19c12c8d9610d3da344c5`;
- [x] the tag-triggered publication workflow succeeded;
- [x] npm accepted and published `@nublox/metaobject@1.0.0` under `latest` with Apache-2.0 package metadata and GitHub Actions provenance.

## `rc.2` rule

Create `1.0.0-rc.2` only if stable-promotion qualification exposes a defect that requires changing the core v1 runtime behavior, public declarations or supported compatibility contract.

Do **not** create a core RC solely for database-adapter changes, MySQL-specific fixes, documentation changes, release automation or package metadata.

## Non-core work

Database-specific drivers/adapters, application-framework integration, NuBlox product UI and application-specific domain metadata remain outside the core stable-v1 scope when implemented as separate packages.

See `mysql-m76-publication-promotion.md` for publication hardening and `m77-stable-v1-promotion.md` for the exact stable-v1 qualification and release sequence.
