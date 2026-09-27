# Release-candidate readiness

This document defines the finite gate for the first `@nublox/metaobject` v1.0 release candidate. Milestone numbers are sequencing aids, not a requirement to inflate scope.

## Current position

M62–M67 hardening is complete. M68 freezes that verified scope as `1.0.0-rc.1`. The release candidate is licensed under Apache-2.0 with copyright held by Stephen J T Spittal. The licensing change must pass the complete supported-Node and clean-consumer gate before merge; the resulting `main` commit must then pass the same gate before it is tagged.

## Completed milestones

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
- establishes changelog/release-note and release procedures;
- makes package publication and licensing an explicit release decision.

### M66 — Documentation convergence ✅

- README and architecture documentation match the implemented package;
- documentation is indexed by architectural concern;
- end-to-end examples cover metadata, modules, runtime control, trust, adapters and release verification;
- stability, extension-point, package-boundary and publication expectations are documented.

### M67 — Adversarial hardening ✅

- audits malformed-input, replay and tamper coverage across persistence, journals, portable evidence and trust formats;
- adds an RC adversarial matrix for M59–M62;
- hardens M60 governance and M61 rotation replay against backward timestamp regression;
- preserves fail-closed behavior for unsupported formats, broken revisions/stages, frozen identity mutation, graph ambiguity and digest mismatch;
- records the hardening audit in `docs/adversarial-hardening.md`.

### M68 — `v1.0.0-rc.1` ✅ candidate prepared

- feature scope frozen at M67;
- package version set to `1.0.0-rc.1`;
- release notes and README updated for the first v1 RC;
- package licensed under Apache-2.0 with `LICENSE` and `NOTICE` included in the distributable payload;
- copyright attribution identifies Stephen J T Spittal;
- the candidate must pass the complete release gate on the licensing PR head and again on the merged `main` commit before tagging.

## RC gate

`v1.0.0-rc.1` is eligible for tagging only when all of the following are true:

- [x] trust-root supersession resolves to one unambiguous current authority;
- [x] public API surface is reviewed and intentionally exported;
- [x] storage/persistence adapter contracts have a reusable conformance suite;
- [x] package contents and clean-consumer imports are CI-verified;
- [x] supported Node versions are tested explicitly;
- [x] README and architecture documentation match implemented scope;
- [x] portable evidence formats have adversarial/tamper coverage;
- [x] no known fail-open trust, lifecycle, concurrency, or persistence defect remains;
- [x] licence/publication status is intentionally decided: Apache-2.0, copyright © 2026 Stephen J T Spittal;
- [ ] exact licensed `1.0.0-rc.1` merged `main` commit is green and reproducible.

## Tagging rule

The tag `v1.0.0-rc.1` must point at the exact licensed merged `main` commit whose Node 20/22/24 and package/clean-consumer checks all completed successfully. A green PR head alone is not sufficient for the final tag.

## Non-blocking post-RC work

The following remain outside the core RC when implemented in separate packages: database-specific drivers/adapters, application-framework integration, NuBlox product UI, and application-specific domain metadata.
