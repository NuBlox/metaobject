# Changelog

All notable changes to `@nublox/metaobject` are recorded here.

The project follows Semantic Versioning once the v1 public API is released. Pre-1.0 milestone versions may still contain compatibility changes, but the RC line is treated as a stabilization period and breaking changes require explicit documentation.

## Unreleased

### Added

- Release-engineering verification for package contents and clean consumers.
- CI coverage for Node.js 20, 22 and 24.

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
