# Public API and compatibility policy

`@nublox/metaobject` exposes one supported package entrypoint: `@nublox/metaobject`.

The package `exports` map intentionally exposes only the root entrypoint. Source-file and `dist/*` deep imports are implementation details and are not compatibility guarantees.

## Public API generation

The v1 compatibility generation is identified by:

```ts
METAOBJECT_PUBLIC_API_VERSION === "1"
```

This marker is independent of the npm package version. It changes only when the supported public API generation changes incompatibly.

## Supported surface

For the v1 release line, symbols exported from the package root are reviewed as the supported API surface. They fall into these groups:

- metadata definitions, inference and metadata catalog contracts;
- runtime object, behavior, graph, registry and validation contracts;
- query planning/execution contracts;
- storage and repository contracts, including reference in-memory implementations;
- schema evolution, code generation and release coordination;
- metadata modules, runtime profiles and deployment lifecycle;
- runtime posture, drift, remediation, fleet control and convergence contracts;
- recovery evidence, signatures, trust policy, trust-root governance, rotation and chain resolution;
- documented error classes.

Reference in-memory stores are public because they are useful for tests, examples and conformance verification. They are reference implementations, not durability guarantees for production systems.

## Error contract

The public error hierarchy is:

- `MetaObjectError`
  - `MetadataError`
  - `ValidationError`
  - `ConcurrencyError`
  - `ObjectTypeNotFoundError`
  - `AttributeTypeNotFoundError`

Consumers should prefer error class identity over matching message text. Error messages provide diagnostic context but are not stable machine-readable codes.

## Compatibility rules for v1

After `v1.0.0`:

- removing or renaming a root-exported symbol is a breaking change;
- changing a required parameter, return contract or persisted portable format incompatibly is a breaking change;
- adding optional properties, new overloads, new exports or new union members is evaluated conservatively and documented in release notes;
- bug fixes may tighten validation where previously accepted input violated an already documented invariant;
- deep source imports are unsupported and may move without a major release;
- database-specific adapters remain separate packages and must target the public core contracts rather than internal modules.

During the release-candidate period, an API change is allowed only when it closes an RC blocker and must be called out explicitly in release notes.

## Consumer contract tests

`type-tests/public-api.ts` compiles representative external-consumer usage exclusively through `src/index.ts`, mirroring the package root. CI therefore fails if core metadata helpers, repository/storage contracts, reference memory storage, public errors or the API-generation marker disappear or become type-incompatible.

M64 extends this stability work with executable storage/adapter conformance suites.
