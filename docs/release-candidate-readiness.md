# Release-candidate readiness

This document records the completed first-v1 release-candidate gate and the criteria for promoting `@nublox/metaobject` to stable v1.

## Current position

M62–M68 are complete and `@nublox/metaobject@1.0.0-rc.1` is tagged and published on npm under `next` with Apache-2.0 licensing and copyright held by Stephen J T Spittal.

M69–M75 then exercised the published core contract through the independent MySQL storage adapter without requiring a core public-API or runtime correction. The adapter passed packed clean-consumer verification on Node.js 22/24 and full live persistence/certification on MySQL 8.0 and 8.4.

At M76 start, comparing `v1.0.0-rc.1` with the M75 `main` commit showed no changes under core `src/`, `test/`, `type-tests/`, or the root `package.json`. Post-RC commits were confined to the database-specific adapter, CI and documentation. There is therefore no current technical evidence requiring `1.0.0-rc.2`.

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

`@nublox/metaobject@1.0.0` is eligible for promotion only when all of the following are true:

- [x] the v1 public API boundary remains generation `"1"`;
- [x] no known fail-open trust, lifecycle, concurrency or persistence defect remains;
- [x] clean package consumers remain green;
- [x] supported Node.js 20/22/24 checks remain green;
- [x] the published RC has been exercised by an independent database adapter without requiring a core contract change;
- [x] MySQL 8.0/8.4 qualification demonstrates the persistence contracts are externally implementable;
- [x] post-RC development has not altered core runtime source or public declarations;
- [x] release publication is protected by pre-publish verification and canonical repository metadata;
- [ ] the final `1.0.0` version/changelog-only promotion commit passes the complete release gate;
- [ ] the exact `v1.0.0` tag is created from that green `main` commit;
- [ ] npm registry verification confirms `@nublox/metaobject@1.0.0` and `latest: 1.0.0`.

## `rc.2` rule

Create `1.0.0-rc.2` only if stable-promotion work exposes a defect that requires changing the core v1 runtime behavior, public declarations or supported compatibility contract.

Do **not** create a core RC solely for database-adapter changes, MySQL-specific fixes, documentation changes, release automation or package metadata.

## Non-core work

Database-specific drivers/adapters, application-framework integration, NuBlox product UI and application-specific domain metadata remain outside the core stable-v1 scope when implemented as separate packages.

See `mysql-m76-publication-promotion.md` for publication hardening and the operational promotion sequence.
