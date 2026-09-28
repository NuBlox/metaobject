# M80 — MySQL adapter stable v1 promotion

## Objective

M80 promotes `@nublox/metaobject-storage-mysql` from the qualified `0.9.0` line to stable `1.0.0` without changing persistence, query, migration, codec or concurrency semantics.

The stable adapter remains pinned to:

- `@nublox/metaobject@1.0.0`;
- `@nublox/mysql@3.1.0-rc.1`;
- Node.js 22 or newer;
- MySQL 8.x.

## Promotion boundary

The implementation being promoted was already qualified through M69–M79:

- runtime-object persistence and optimistic concurrency;
- transactional metadata persistence;
- safe SQL query pushdown with deterministic JavaScript fallback;
- append-only checksummed physical-schema migrations;
- MySQL 8.0 and 8.4 live conformance/certification;
- clean packed-consumer verification on Node.js 22 and 24;
- exact case-sensitive and trailing-space-sensitive object/metadata identities in physical schema v3;
- trusted GitHub Actions npm publication with provenance.

M80 intentionally does not broaden the stable-v1 runtime contract. It changes release metadata and publication policy only.

## Version and npm channel

The package version advances:

```text
0.9.0 -> 1.0.0
```

Stable adapter releases publish under npm `latest`. Prerelease versions containing a SemVer prerelease component continue to publish under `next`.

The package manifest and release workflow both enforce this boundary:

```text
stable version      -> latest
prerelease version  -> next
```

`packages/storage-mysql/scripts/verify-package.mjs` independently verifies that `publishConfig.tag` matches the package version class before a package can pass `release:check`.

## Trusted publication

The immutable release tag for the stable adapter is:

```text
storage-mysql-v1.0.0
```

The tag-triggered GitHub Actions workflow:

1. verified that the tag exactly matched `packages/storage-mysql/package.json`;
2. verified that the tagged commit was contained in `main`;
3. installed dependencies with lifecycle-safe repository settings;
4. ran the complete package release gate;
5. selected npm `latest` for the stable version;
6. published through npm trusted publishing with provenance.

## Qualification and publication evidence

- M80 pull request: `#90`;
- merged `main` commit: `64c99d54c0b00c29b058e0f6dc3eb9df86357c52`;
- immutable release tag: `storage-mysql-v1.0.0`;
- tag-triggered publish workflow run: `36400098786`;
- published package: `@nublox/metaobject-storage-mysql@1.0.0`;
- npm dist-tags after registry propagation: `latest=1.0.0`, `next=0.9.0`;
- Sigstore transparency-log index emitted by the publish workflow: `2981675400`;
- clean external consumer installation of exact version `1.0.0`: passed;
- core qualification: 384 tests passed, 0 failed;
- adapter unit qualification: 14 tests passed, 0 failed.

The initial npm metadata checks immediately after publication still showed the previous dist-tags while npm was processing the release. A later direct registry query resolved exact version `1.0.0` and `latest=1.0.0`, and a clean temporary consumer successfully installed `@nublox/metaobject-storage-mysql@1.0.0`.

## Compatibility statement

M80 is a release-line stabilization milestone, not a behavioural rewrite.

Consumers already qualified against `0.9.0` should observe the same public adapter API and runtime semantics at `1.0.0`. The stable version establishes the adapter's SemVer compatibility boundary for future releases.

Published `0.8.0` and `0.9.0` packages remain immutable and available through their exact versions.

## Completion evidence

M80 is complete:

- [x] package version is `1.0.0`;
- [x] stable manifest publication channel is `latest`;
- [x] workflow selects `latest` for stable and `next` for prerelease versions;
- [x] package verification enforces the semantic dist-tag policy;
- [x] pull-request CI passes;
- [x] M80 is merged to `main`;
- [x] `storage-mysql-v1.0.0` is created from the exact green `main` commit;
- [x] trusted publication succeeds;
- [x] npm `latest` resolves to `@nublox/metaobject-storage-mysql@1.0.0`;
- [x] provenance is verified and the final publication evidence is recorded.
