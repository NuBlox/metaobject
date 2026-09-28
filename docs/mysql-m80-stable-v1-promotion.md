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

The tag-triggered GitHub Actions workflow must:

1. verify that the tag exactly matches `packages/storage-mysql/package.json`;
2. verify that the tagged commit is contained in `main`;
3. install dependencies with lifecycle-safe repository settings;
4. run the complete package release gate;
5. select the semantic npm dist-tag;
6. publish through npm trusted publishing with provenance.

The release is not complete until npm reports `@nublox/metaobject-storage-mysql@1.0.0` under `latest` and the provenance evidence is visible for the published package.

## Required qualification

Before tagging, the M80 branch/main commit must pass the existing release qualification unchanged:

```bash
cd packages/storage-mysql
npm install --package-lock=false
npm run release:check
```

The repository CI additionally executes the supported Node.js clean-consumer lanes and live MySQL 8.0/8.4 persistence, migration, identity and certification lanes.

## Compatibility statement

M80 is a release-line stabilization milestone, not a behavioural rewrite.

Consumers already qualified against `0.9.0` should observe the same public adapter API and runtime semantics at `1.0.0`. The stable version establishes the adapter's SemVer compatibility boundary for future releases.

Published `0.8.0` and `0.9.0` packages remain immutable and available through their exact versions.

## Completion evidence

M80 is complete only after all of the following are true:

- [x] package version is `1.0.0`;
- [x] stable manifest publication channel is `latest`;
- [x] workflow selects `latest` for stable and `next` for prerelease versions;
- [x] package verification enforces the semantic dist-tag policy;
- [ ] pull-request CI passes;
- [ ] M80 is merged to `main`;
- [ ] `storage-mysql-v1.0.0` is created from the exact green `main` commit;
- [ ] trusted publication succeeds;
- [ ] npm `latest` resolves to `@nublox/metaobject-storage-mysql@1.0.0`;
- [ ] provenance is verified and the final publication evidence is recorded.
