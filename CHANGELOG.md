# Changelog

All notable changes to `@nublox/metaobject` are recorded here.

The project follows Semantic Versioning once the v1 public API is released. The release-candidate line was treated as a stabilization period and breaking changes required explicit documentation.

## Unreleased

## 1.2.0

Adds the first NuBloxMetaObject single-entry platform facade while preserving the existing stable-v1 primitives.

### Added

- `createMetaObject()` as the primary product-level entry point.
- `MetaObjectPlatform` owning built-in types, object metadata registration, object creation, validation, repository operations and storage selection.
- `defineObject()` and `meta.*` built-in attribute builders for concise metadata definitions with TypeScript inference.
- Built-in memory storage selection plus caller-owned `StorageAdapter` injection for external providers.
- Platform capability discovery through `supports()` and `descriptor()`.

### Architecture

- The facade establishes the boundary required for NuBloxSQL-backed SQL storage providers without coupling application code to a dialect adapter.
- Existing low-level exports remain available and source-compatible; the facade is additive.

## 1.1.1

Patch release correcting the reusable M81 query-comparison conformance fixture for production persistent adapters.

### Fixed

- `runQueryComparisonConformance()` no longer seeds an invalid `Date`, which conforming persistent adapters may correctly reject at their persistence boundary.
- The cross-adapter Date vector now uses only persistable Date values while continuing to prove deterministic persisted Date ordering.
- Invalid-Date comparison semantics remain covered by core comparison-policy tests rather than being imposed as a storage-persistence requirement.

### Compatibility

- No runtime comparison semantics change is introduced.
- `legacy-js-v1` remains the default and `deterministic-codepoint-v1` remains opt-in.
- `METAOBJECT_PUBLIC_API_VERSION` remains `"1"`.
- Existing public query and storage contracts are unchanged.

### Distribution

- Stable publication remains under npm `latest` through the trusted GitHub Actions workflow from the exact green `v1.1.1` tag on `main`.

## 1.1.0

First compatible v1 minor release, establishing explicit query-comparison semantics and adapter pushdown capability negotiation.

### Added

- Public `QueryPushdownCapabilities` vocabulary for filter, ordered-filter, attribute-ordering and pagination proof.
- Stable comparison-semantics identifiers for `legacy-js-v1` and opt-in `deterministic-codepoint-v1`.
- Explicit `comparisonSemantics` selection on `ObjectQuery` and `MetaQuery`; omission preserves the stable-v1 legacy behaviour.
- Shared stable-v1 and deterministic scalar-comparison helpers exported from the package root.
- Deterministic Unicode code-point string ordering, explicit scalar-kind ordering, special-number handling, Date ordering and configurable null placement.
- Reusable `runQueryComparisonConformance()` differential qualification for production storage adapters.

### Changed

- `MemoryStorageAdapter` and `QueryEngine` now consume centralized comparison semantics rather than duplicating comparator logic.
- Query range filtering, ordering, cursor continuation and min/max aggregation can execute the deterministic policy when explicitly selected.
- The public API generation remains `METAOBJECT_PUBLIC_API_VERSION === "1"`; this is a compatible extension of the stable v1 contract.

### Compatibility

- Existing callers that omit `comparisonSemantics` retain `legacy-js-v1` behaviour.
- Historical differences between storage-level and MetaQuery legacy comparison, including `NaN` and signed-zero edge behaviour, are intentionally preserved and regression-tested.
- Existing `StorageAdapter` implementations remain source-compatible because capability declarations are optional.
- Unknown comparison-semantics identifiers fail closed when ordered comparison is required.
