# Release engineering

## Supported Node.js versions

The v1 line supports Node.js 20, 22 and 24. CI runs the complete typecheck/build/test gate on all three versions.

## Required release gate

Run:

```bash
npm install --package-lock=false
npm run release:check
```

`release:check` executes the full package checks, validates release metadata and npm package contents, installs the generated tarball into a clean consumer fixture, verifies ESM runtime imports and compiles TypeScript imports from the public package root.

Every publishable package also uses `prepublishOnly` to rerun its release gate immediately before `npm publish`.

## Package contents

The published/installable core package is intentionally limited to:

- `package.json`;
- `README.md`;
- `LICENSE`;
- `NOTICE`;
- generated `dist/**` JavaScript and declarations.

Source, tests, internal docs, CI configuration and release scripts are not part of the package payload.

## Publication and licence status

`@nublox/metaobject` is licensed under the Apache License, Version 2.0 (`Apache-2.0`). Copyright © 2026 Stephen J T Spittal.

The licence text and attribution notice are distributed with every package tarball as `LICENSE` and `NOTICE`. Package verification fails if either file is absent or if required release metadata drifts unexpectedly.

`@nublox/metaobject@1.0.0-rc.1` has been published under the npm `next` dist-tag. Subsequent releases still require an exact green release commit and explicit publication action.

## Trusted publishing

The repository contains OIDC-ready GitHub Actions publication workflows for the core package and MySQL storage adapter. They use GitHub-hosted runners, `id-token: write`, Node.js 24 and an npm CLI capable of trusted publishing.

Trusted publisher configuration is managed on npm per package. The package `repository.url` must remain exactly aligned with `https://github.com/NuBlox/metaobject`.

The core workflow uses semantic dist-tags: prerelease versions publish under `next`; non-prerelease versions publish under `latest`.

The MySQL adapter is protected by package `publishConfig` as public under `next` until its release policy is deliberately changed.

## Release notes

`CHANGELOG.md` is the canonical human-readable release history. Each release records externally observable additions, changes, removals, fixes and security changes as applicable.

## Release procedure

1. ensure `main` is green on every supported Node version and all package-specific qualification lanes;
2. run the package release gate from a clean checkout;
3. verify `package.json` version, repository metadata and `Apache-2.0` licence metadata;
4. verify `LICENSE` and `NOTICE` are present in the generated package;
5. update `CHANGELOG.md` and release documentation;
6. create the exact release tag from the verified `main` commit;
7. publish from that exact tag/commit, preferably through npm trusted publishing;
8. immediately verify the registry version, licence and dist-tags;
9. never attempt to replace an already-published immutable version; increment the version for every correction.

See `mysql-m76-publication-promotion.md` for first-publication handling, trusted-publisher setup and the stable-v1 promotion boundary.
