# Release-candidate readiness

This document defines the finite gate for the first `@nublox/metaobject` v1.0 release candidate. Milestone numbers are sequencing aids, not a requirement to inflate scope.

## Current position

The package has a substantial standalone kernel, strict TypeScript checking, compile-time type tests, a broad Node runtime test suite, database-neutral contracts, metadata/versioning/release machinery, runtime convergence controls, and the M49–M62 integrity/trust chain.

The first RC should be cut when the existing scope is hardened and documented. New product features are not RC blockers unless they close one of the gates below.

## Proposed remaining milestones

### M62 — Trust-root chain verification ✅

Implemented:

- verifies M59 snapshot digests, M60 governance replay and M61 rotation replay as one authority chain;
- deterministically resolves exactly one active authoritative root;
- rejects forks, merges, cycles, incomplete rotations, missing exact governance links, digest mismatches, multiple active roots and disconnected completed rotation islands;
- returns the complete oldest-to-current authority lineage without rewriting historical evidence.

### M63 — Public API stabilization

- inventory every root export;
- identify accidental/internal exports;
- normalize naming and error semantics;
- define compatibility expectations for the v1 public surface;
- add API-focused type tests for supported consumer usage.

### M64 — Storage/adapter conformance

- publish a reusable conformance suite for `StorageAdapter` and persistence contracts;
- verify memory implementations against the same contract;
- define the compatibility boundary for external MySQL/PostgreSQL/SQLite adapter packages;
- keep database drivers outside core.

### M65 — Release engineering

- add deterministic package-content verification (`npm pack --dry-run` or equivalent CI gate);
- validate ESM/type declarations from a clean consumer fixture;
- establish supported Node versions in CI;
- add changelog/release notes conventions;
- decide package licence before any public publication.

### M66 — Documentation convergence

- bring the README implemented-scope and roadmap sections up to the current milestone;
- add architecture/index documentation for M14–M62;
- provide minimal end-to-end examples for metadata definition, persistence, modules, runtime control, and trust verification;
- document stability/compatibility guarantees and extension points.

### M67 — Adversarial hardening

- add malformed-input and replay/tamper matrices across portable formats;
- add boundary/property-style tests for canonicalization, revisions, lifecycle replay, and graph invariants;
- audit fail-open paths and exception handling;
- run clean install, build, typecheck, tests, and package-consumer verification on the supported Node matrix.

### M68 — `v1.0.0-rc.1`

- freeze feature scope;
- close all RC-blocking defects;
- confirm public API review;
- confirm documentation and release metadata;
- tag and build the release candidate from a green `main` commit.

## RC gate

`v1.0.0-rc.1` is ready only when all of the following are true:

- [x] trust-root supersession resolves to one unambiguous current authority;
- [ ] public API surface is reviewed and intentionally exported;
- [ ] storage/persistence adapter contracts have a reusable conformance suite;
- [ ] package contents and clean-consumer imports are CI-verified;
- [ ] supported Node versions are tested explicitly;
- [ ] README and architecture documentation match implemented scope;
- [ ] portable evidence formats have adversarial/tamper coverage;
- [ ] no known fail-open trust, lifecycle, concurrency, or persistence defect remains;
- [ ] licence/publication status is intentionally decided;
- [ ] `main` is green and the RC commit is reproducible.

## Non-blocking post-RC work

The following can remain outside the core RC when implemented in separate packages: database-specific drivers/adapters, application-framework integration, NuBlox product UI, and application-specific domain metadata.
