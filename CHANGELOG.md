# Changelog

All notable changes to `@nublox/metaobject` are recorded here.

The project follows Semantic Versioning once the v1 public API is released. The release-candidate line was treated as a stabilization period and breaking changes required explicit documentation.

## Unreleased

## 1.0.0

First stable v1 release of the standalone `@nublox/metaobject` runtime.

### Changed

- Package version advances from `1.0.0-rc.1` to `1.0.0`.
- Public API generation `1` becomes the stable SemVer compatibility boundary exposed through the package root.
- Canonical GitHub repository, homepage and issue metadata are included in the package manifest.
- `prepublishOnly` enforces the complete release gate before any npm publication attempt.
- OIDC-ready GitHub Actions publication workflow scaffolding supports trusted npm publishing and semantic `next`/`latest` dist-tags.

### Compatibility

- No core runtime source or public declaration change is introduced between the published `1.0.0-rc.1` runtime contract and this stable promotion.
- M69–M75 exercised the published RC contract through the independent MySQL adapter, including packed clean consumers and live MySQL 8.0/8.4 conformance/certification, without requiring a core contract correction.
- Deep imports from generated `dist/**` paths remain outside the public compatibility contract.

### Distribution

- Licensed under the Apache License, Version 2.0 (`Apache-2.0`).
- Copyright © 2026 Stephen J T Spittal.
- Stable npm publication is a separate release action from this version/changelog promotion commit and must originate from the exact green `v1.0.0` tag.

## 1.0.0-rc.1

First v1 release candidate for the standalone `@nublox/metaobject` runtime.

### Added

- Stable public API generation 1 exposed through the package root.
- Metadata-driven runtime objects, relationships, inheritance, composition, validation and behaviours.
- Database-neutral object and metadata persistence contracts with reusable adapter conformance suites.
- Query planning/execution, code generation, schema evolution and governed metadata release.
- Versioned metadata modules, exact module-set lockfiles and reproducible runtime profiles.
- Governed deployment execution, append-only evidence, attestations, drift/remediation and runtime posture.
- Fleet reconciliation, convergence execution, fair dispatch, handoff recovery and immutable recovery evidence.
- Deterministic integrity, external signature providers, signer/quorum trust policy, portable historical trust bundles and externally anchored trust roots.
- External trust-root governance, recoverable rotation/supersession and deterministic authoritative-chain resolution.
- Package-manifest verification, clean ESM/TypeScript consumer verification and Node.js 20/22/24 CI coverage.
- Release-candidate adversarial/tamper matrix and fail-closed lifecycle replay hardening.
- Apache License 2.0 distribution terms, with `LICENSE` and `NOTICE` included in the package payload.

### Changed

- Package version advances from the milestone series to `1.0.0-rc.1`.
- The package root is the supported v1 compatibility boundary; generated `dist/**` deep imports are not public contracts.
- Package licence changes from `UNLICENSED` to `Apache-2.0` with copyright held by Stephen J T Spittal.

### Fixed

- External trust-root governance and rotation replay reject backward timestamp regression while preserving valid equal timestamps.

### Distribution

- `@nublox/metaobject` is licensed under the Apache License, Version 2.0.
- Copyright © 2026 Stephen J T Spittal.
- Applying the licence does not itself publish the package; npm publication remains an explicit release operation.

## 0.67.0

### Added

- Release-candidate adversarial matrix covering malformed governance/rotation histories, duplicate trust-root evidence, missing exact governance provenance, frozen-digest rewriting and canonical digest permutations.
- M67 adversarial-hardening audit documentation.

### Fixed

- M60 external trust-root governance replay now rejects backward timestamp regression.
- M61 external trust-root rotation replay now rejects backward timestamp regression.

## 0.66.0

### Added

- Current architecture documentation through M65.
- Documentation index grouped by architectural concern.
- End-to-end workflow examples for metadata, modules, runtime control, trust, adapters and release verification.

### Changed

- README scope, compatibility, release and RC-roadmap sections now match the implemented package.

## 0.65.0

### Added

- Deterministic `npm pack` manifest verification.
- Clean runtime and TypeScript consumer installation verification.
- Supported Node.js CI matrix.
- Release process and publication policy documentation.

### Changed

- GitHub Actions checkout/setup-node actions upgraded to the Node-24-compatible major versions.

## Release note convention

Each release should use the headings `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` as applicable. Empty headings are omitted. Release notes should describe externally observable behavior and compatibility impact rather than internal commit history.
