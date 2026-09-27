# Release-candidate readiness

This document defines the finite gate for the first `@nublox/metaobject` v1.0 release candidate. Milestone numbers are sequencing aids, not a requirement to inflate scope.

## Current position

The package has a substantial standalone kernel, strict TypeScript checking, compile-time type tests, a broad Node runtime test suite, database-neutral contracts, metadata/versioning/release machinery, runtime convergence controls, the M49–M62 integrity/trust chain, a stabilized M63 public API, reusable M64 adapter conformance, M65 release engineering and converged M66 documentation.

The first RC should be cut when the existing scope is hardened and documented. New product features are not RC blockers unless they close one of the gates below.

## Proposed remaining milestones

### M62 — Trust-root chain verification ✅

Implemented:

- verifies M59 snapshot digests, M60 governance replay and M61 rotation replay as one authority chain;
- deterministically resolves exactly one active authoritative root;
- rejects forks, merges, cycles, incomplete rotations, missing exact governance links, digest mismatches, multiple active roots and disconnected completed rotation islands;
- returns the complete oldest-to-current authority lineage without rewriting historical evidence.

### M63 — Public API stabilization ✅

Implemented:

- establishes the package root as the supported v1 compatibility boundary;
- documents the supported API categories and deep-import policy;
- defines the public error hierarchy and message-stability expectations;
- adds `METAOBJECT_PUBLIC_API_VERSION` as an explicit compatibility-generation marker;
- adds compile-time consumer-contract tests for root imports, metadata helpers, repository/storage contracts, reference storage and public errors;
- documents v1 semantic compatibility rules and RC-period change discipline.

### M64 — Storage/adapter conformance ✅

Implemented:

- exports reusable `StorageAdapter` and `MetadataStore` conformance runners;
- verifies the reference in-memory implementations against the same public contract external adapters must satisfy;
- covers detached reads, optimistic concurrency, atomic batch rollback, request-order results, portable query semantics, filtering and deletion behavior;
- documents the compatibility boundary for MySQL/PostgreSQL/SQLite and other external adapter packages;
- keeps database drivers and dialect-specific dependencies outside core.

### M65 — Release engineering ✅

Implemented:

- deterministic npm package-manifest verification rejects source/test/internal files and requires root runtime/type declarations;
- clean-consumer verification installs the generated tarball and validates both ESM runtime imports and TypeScript declarations;
- CI explicitly tests Node.js 20, 22 and 24;
- GitHub Actions use Node-24-compatible checkout/setup-node majors;
- `CHANGELOG.md` and release-note conventions are established;
- publication/licence status is intentionally `UNLICENSED`: no public npm publication until NuBlox explicitly changes that decision.

### M66 — Documentation convergence ✅

Implemented:

- README current scope and RC roadmap now match M0–M65 implementation;
- architecture documentation describes runtime, persistence, modules, deployment, fleet convergence and trust layers through M65;
- a documentation index groups the package docs by architectural concern;
- end-to-end examples cover metadata definition/persistence, module runtime reconstruction, runtime control, trust verification, adapter conformance and release verification;
- stability, extension-point, package-boundary and publication expectations are linked from the main package documentation.

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
- [x] public API surface is reviewed and intentionally exported;
- [x] storage/persistence adapter contracts have a reusable conformance suite;
- [x] package contents and clean-consumer imports are CI-verified;
- [x] supported Node versions are tested explicitly;
- [x] README and architecture documentation match implemented scope;
- [ ] portable evidence formats have adversarial/tamper coverage;
- [ ] no known fail-open trust, lifecycle, concurrency, or persistence defect remains;
- [x] licence/publication status is intentionally decided;
- [ ] `main` is green and the RC commit is reproducible.

## Non-blocking post-RC work

The following can remain outside the core RC when implemented in separate packages: database-specific drivers/adapters, application-framework integration, NuBlox product UI, and application-specific domain metadata.
