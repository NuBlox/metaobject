# M76 publication hardening and v1 promotion gate

M76 hardens release publication for `@nublox/metaobject` and `@nublox/metaobject-storage-mysql` after the M75 external-consumer qualification gate.

## Current release position

- `@nublox/metaobject@1.0.0-rc.1` is already published on npm under `next`.
- `@nublox/metaobject-storage-mysql@0.7.0` has passed M75 but has not yet had its first npm publication.
- comparing `v1.0.0-rc.1` with the M75 `main` commit shows no changes under core `src/`, `test/`, `type-tests/`, or the root `package.json`; post-RC development is confined to the MySQL adapter, CI and documentation.
- no core v1 public-contract change has been required by M69-M75, so there is currently no technical evidence requiring `1.0.0-rc.2`.

## Package publication invariants

Both publishable packages now carry an exact GitHub `repository.url`, homepage and issue tracker. The root and adapter `prepublishOnly` hooks execute their release gates before any `npm publish` operation.

The MySQL adapter additionally fixes:

```json
"publishConfig": {
  "access": "public",
  "tag": "next"
}
```

This protects the first pre-1.0 adapter publication from accidentally becoming the npm `latest` release.

Package verification fails closed if the expected repository, author, licence, pre-publish gate, or adapter publication policy changes unexpectedly.

## First MySQL adapter publication

The first `@nublox/metaobject-storage-mysql` publication must be performed interactively because npm trusted-publisher configuration requires the package to already exist on the registry.

From the exact verified `main` commit:

```bash
cd packages/storage-mysql
npm install --package-lock=false
npm run release:check
npm publish
```

`npm publish` uses the package `publishConfig`, so the intended result is a public `0.7.0` publication under `next`.

Verify immediately:

```bash
npm view @nublox/metaobject-storage-mysql@0.7.0 version
npm view @nublox/metaobject-storage-mysql@0.7.0 license
npm view @nublox/metaobject-storage-mysql dist-tags
```

The expected values are `0.7.0`, `Apache-2.0`, and `next: 0.7.0` respectively.

## Trusted publishing after the first adapter release

The repository contains two OIDC-ready workflows:

- `.github/workflows/publish-metaobject.yml`
- `.github/workflows/publish-storage-mysql.yml`

They require GitHub-hosted runners, `id-token: write`, Node.js 24, and an npm CLI new enough for trusted publishing. Both verify that the release tag exactly matches the package version and that the tagged commit belongs to `main` before running the package release gate and publishing.

After `@nublox/metaobject-storage-mysql` exists on npm, configure its trusted publisher with:

- provider: GitHub Actions;
- GitHub owner: `NuBlox`;
- repository: `metaobject`;
- workflow filename: `publish-storage-mysql.yml`;
- allowed action: `npm publish`.

For `@nublox/metaobject`, configure the corresponding trusted publisher against `publish-metaobject.yml` before stable v1 publication.

Trusted publishing should be preferred over long-lived npm write tokens. Public packages published from this public GitHub repository through npm trusted publishing receive npm provenance automatically.

## Release tags

Core releases use tags matching the package version:

```text
v1.0.0
v1.0.1
v1.1.0
```

The core publication workflow publishes prerelease versions under `next` and non-prerelease versions under `latest`.

MySQL adapter releases use package-specific tags:

```text
storage-mysql-v0.7.1
storage-mysql-v0.8.0
```

The current adapter line remains protected under the `next` dist-tag by `publishConfig` until that policy is deliberately changed for an eventual stable adapter release.

## Stable core promotion assessment

The final `@nublox/metaobject@1.0.0` promotion should not add new runtime features. The stable candidate should be the RC public contract plus release metadata/version/changelog updates only.

A new `rc.2` is warranted only if one of the following is found before stable publication:

- a defect in the v1 public API contract;
- a correctness or fail-open defect in core runtime/trust/persistence behavior;
- a clean-consumer incompatibility that requires changing core runtime code or declarations;
- a supported Node-version failure that requires a core behavioral change.

Adapter-only changes, MySQL-specific fixes, documentation changes, release automation, or package metadata do not by themselves require another core RC.

## M76 acceptance criteria

M76 is complete when:

- core and adapter package metadata identify the canonical GitHub repository;
- every publish operation is guarded by `prepublishOnly` release verification;
- adapter publication defaults to public `next`;
- package verifiers enforce the release metadata invariants;
- OIDC-ready release workflows exist for core and adapter packages;
- core Node 20/22/24 and clean-consumer CI remains green;
- MySQL 8.0/8.4 and adapter clean-consumer CI remains green;
- the stable-core promotion decision is documented without introducing new core runtime scope.

M76 prepares and protects publication. It does not claim that the MySQL adapter has been published until registry verification succeeds.
