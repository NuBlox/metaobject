# End-to-end examples

These examples show the intended composition of the public APIs. They focus on package boundaries and sequencing rather than application-specific policy or database code.

## 1. Define, instantiate and persist an object

```ts
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "@nublox/metaobject";

const types = createDefaultTypeRegistry();
const objects = new ObjectTypeRegistry(types);

const Asset = defineObjectType({
  id: "example.asset",
  name: "Asset",
  version: 1,
  attributes: {
    name: { type: "string", required: true },
    cost: { type: "decimal" },
  },
} as const);

objects.register(Asset);

const factory = new ObjectFactory(objects, types);
const storage = new MemoryStorageAdapter();
const repository = new MetaObjectRepository(storage, factory, new Validator());

const asset = factory.create(Asset, { name: "Crane", cost: 125000 });
await repository.save(asset);
```

Replace `MemoryStorageAdapter` with an external adapter implementing `StorageAdapter` without changing the runtime model.

## 2. Persist versioned metadata

```ts
import {
  MemoryMetadataStore,
  MetadataCatalog,
  createDefaultTypeRegistry,
} from "@nublox/metaobject";

const metadata = new MetadataCatalog(
  new MemoryMetadataStore(),
  createDefaultTypeRegistry(),
);
```

The catalogue owns metadata lifecycle operations while `MetadataStore` owns durable records, optimistic revisions and atomic batch persistence. Database-backed metadata stores should run `runMetadataStoreConformance()` in their own CI.

## 3. Release metadata modules and reconstruct an exact runtime

The module path is intentionally explicit:

```text
Object-type drafts
      |
      v
MetadataCatalog
      |
      v
Metadata module draft
      |
      v
PersistentMetadataModuleReleaseManager
      |
      v
Published module + exact dependency manifest
      |
      v
MetadataModuleSetResolver
      |
      v
nublox-metaobject-module-set lockfile
      |
      v
ObjectTypeRegistry reconstructed from exact versions
```

A typical consumer creates `MetadataModuleCatalog` with a `MetadataModuleStore`, releases the module graph, then uses `MetadataModuleSetResolver.resolve()` to freeze one exact dependency-first runtime closure. `buildObjectTypeRegistry()` reconstructs the exact published object definitions recorded by that lockfile.

The important invariant is that published module history never re-resolves an older dependency against today's newest compatible version.

## 4. Govern a runtime change

Runtime control is layered rather than exposed as one unsafe deploy call:

```text
Activated runtime profile
      |
      v
Runtime profile upgrade plan
      |
      v
Runtime deployment record
      |
      +--> approval/policy gate
      +--> durable step leases
      +--> keyed or reconciled external executor
      +--> append-only journal
      |
      v
Completed deployment
      |
      v
Post-deployment attestation
      |
      v
Drift baseline / assessment
      |
      v
Runtime posture
```

External executors perform database/application side effects. Core persists the exact plan and controls optimistic concurrency, idempotency identity, recovery, policy evidence and post-deployment verification.

Fleet orchestration builds on this same path: reconciliation creates durable convergence work, execution/dispatch selects bounded work, and fairness/reservation/handoff layers prevent conflicting workers from bypassing the lower-level deployment controls.

## 5. Verify recovery evidence and current external trust authority

The trust chain deliberately separates evidence integrity from external authority:

```text
Recovery chain evidence
      |
      v
M49 deterministic integrity root
      |
      v
M50 external signatures
      |
      v
M51 signer/quorum trust evaluation
      |
      v
M52 immutable policy snapshot
      |
      v
M53-M57 policy lifecycle + portable historical bundle
      |
      v
M58 externally anchored bundle root
      |
      v
M59 immutable external trust-root snapshot
      |
      v
M60 governance
      |
      v
M61 recoverable root rotation
      |
      v
M62 authoritative root-chain resolution
```

For current authority, construct `RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver` with the M59 snapshot store, M60 governance catalogue and M61 rotation catalogue, then call `resolve()`.

A successful resolution returns one authoritative snapshot/root digest plus the complete oldest-to-current lineage. Resolution fails closed on tampered digests, forks, merges, cycles, incomplete rotations, multiple active roots or disconnected completed rotation islands.

## 6. Verify an external adapter before use

```ts
import {
  runMetadataStoreConformance,
  runStorageAdapterConformance,
} from "@nublox/metaobject";

await runStorageAdapterConformance({
  createAdapter: async () => createDisposableDatabaseAdapter(),
});

await runMetadataStoreConformance({
  createStore: async () => createDisposableMetadataStore(),
});
```

Each conformance check receives a fresh implementation. Database-backed packages should create a clean disposable database/schema or equivalent isolated fixture for every run.

## 7. Release verification

Before an RC or release:

```bash
npm install
npm run release:check
```

This runs the complete tests, validates npm package contents, builds a real tarball, installs it into a clean consumer and verifies both ESM runtime imports and TypeScript declarations.
