import type { MetadataRecord, MetadataStore } from "../metadata/metadata-store.js";
import { normalizeObjectType } from "../metadata/persistence-model.js";
import type { ObjectSnapshot } from "../runtime/model.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";

export interface ConformanceCheckResult {
  readonly name: string;
  readonly passed: true;
}

export interface ConformanceReport {
  readonly contract: "StorageAdapter" | "MetadataStore";
  readonly checks: readonly ConformanceCheckResult[];
}

export interface StorageAdapterConformanceOptions {
  readonly createAdapter: () => StorageAdapter | Promise<StorageAdapter>;
}

export interface MetadataStoreConformanceOptions {
  readonly createStore: () => MetadataStore | Promise<MetadataStore>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  assert(Object.is(actual, expected), `${message}; expected ${String(expected)}, received ${String(actual)}`);
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${message}; expected ${right}, received ${left}`);
}

async function rejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

function snapshot(id: string, score: number): ObjectSnapshot {
  return {
    id,
    type: "conformance.item",
    schemaVersion: 1,
    version: 0,
    values: { score, label: `item-${id}` },
    relationships: {},
  };
}

function metadataRecord(id: string, version: number, status: "draft" | "published" = "draft"): MetadataRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    objectTypeId: id,
    objectTypeVersion: version,
    status,
    revision: 0,
    snapshot: normalizeObjectType({
      id,
      name: id,
      version,
      attributes: { value: { type: "string" } },
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function runStorageAdapterConformance(
  options: StorageAdapterConformanceOptions,
): Promise<ConformanceReport> {
  const checks: ConformanceCheckResult[] = [];
  const check = async (name: string, fn: (adapter: StorageAdapter) => Promise<void>): Promise<void> => {
    const adapter = await options.createAdapter();
    await fn(adapter);
    checks.push({ name, passed: true });
  };

  await check("missing get returns null", async (adapter) => {
    equal(await adapter.get({ type: "conformance.item", id: "missing" }), null, "missing object must return null");
  });

  await check("insert/get round-trip and detached reads", async (adapter) => {
    const inserted = await adapter.insert(snapshot("a", 10));
    equal(inserted.version, 1, "first persisted version must be 1");
    const loaded = await adapter.get({ type: inserted.type, id: inserted.id });
    assert(loaded, "inserted object must be readable");
    deepEqual(loaded, inserted, "stored snapshot must round-trip");
    (loaded.values as Record<string, unknown>).score = 999;
    const reread = await adapter.get({ type: inserted.type, id: inserted.id });
    equal(reread?.values.score, 10, "returned snapshots must not expose mutable store state");
  });

  await check("duplicate insert fails without replacing data", async (adapter) => {
    await adapter.insert(snapshot("dup", 1));
    await rejects(() => adapter.insert(snapshot("dup", 2)), "duplicate insert must reject");
    const current = await adapter.get({ type: "conformance.item", id: "dup" });
    equal(current?.values.score, 1, "failed duplicate insert must preserve original data");
  });

  await check("optimistic update increments version", async (adapter) => {
    const inserted = await adapter.insert(snapshot("update", 1));
    const updated = await adapter.update({ ...inserted, values: { ...inserted.values, score: 2 } }, inserted.version);
    equal(updated.version, 2, "successful update must increment version by one");
    equal(updated.values.score, 2, "successful update must persist replacement values");
    await rejects(
      () => adapter.update({ ...updated, values: { ...updated.values, score: 3 } }, inserted.version),
      "stale update must reject",
    );
    equal((await adapter.get(updated))?.values.score, 2, "stale update must not mutate storage");
  });

  await check("batch writes are atomic and ordered", async (adapter) => {
    const existing = await adapter.insert(snapshot("batch-existing", 1));
    const results = await adapter.saveBatch([
      { kind: "insert", snapshot: snapshot("batch-new", 2) },
      { kind: "update", snapshot: { ...existing, values: { ...existing.values, score: 3 } }, expectedVersion: 1 },
    ]);
    deepEqual(results.map((item) => item.id), ["batch-new", "batch-existing"], "batch result order must match request order");
    equal(results[0]?.version, 1, "batch insert must start at version 1");
    equal(results[1]?.version, 2, "batch update must increment version");

    const before = await adapter.get({ type: "conformance.item", id: "batch-existing" });
    await rejects(
      () => adapter.saveBatch([
        { kind: "insert", snapshot: snapshot("atomic-new", 4) },
        { kind: "update", snapshot: { ...existing, values: { ...existing.values, score: 5 } }, expectedVersion: 1 },
      ]),
      "batch containing a stale write must reject",
    );
    equal(await adapter.get({ type: "conformance.item", id: "atomic-new" }), null, "failed batch must roll back inserts");
    deepEqual(await adapter.get({ type: "conformance.item", id: "batch-existing" }), before, "failed batch must roll back updates");
  });

  await check("query filtering ordering and pagination", async (adapter) => {
    await adapter.saveBatch([
      { kind: "insert", snapshot: snapshot("q1", 30) },
      { kind: "insert", snapshot: snapshot("q2", 10) },
      { kind: "insert", snapshot: snapshot("q3", 20) },
    ]);
    const rows = await adapter.query({
      objectType: "conformance.item",
      where: [{ attribute: "score", operator: "gte", value: 10 }],
      orderBy: [{ attribute: "score", direction: "asc" }],
      offset: 1,
      limit: 1,
    });
    deepEqual(rows.map((item) => item.id), ["q3"], "query must honour filter, ordering, offset and limit");
  });

  await check("delete is optimistic and missing delete is idempotent", async (adapter) => {
    const inserted = await adapter.insert(snapshot("delete", 1));
    await rejects(() => adapter.delete(inserted, inserted.version + 1), "stale delete must reject");
    assert(await adapter.get(inserted), "stale delete must preserve object");
    await adapter.delete(inserted, inserted.version);
    equal(await adapter.get(inserted), null, "successful delete must remove object");
    await adapter.delete(inserted, inserted.version);
  });

  return { contract: "StorageAdapter", checks };
}

export async function runMetadataStoreConformance(
  options: MetadataStoreConformanceOptions,
): Promise<ConformanceReport> {
  const checks: ConformanceCheckResult[] = [];
  const check = async (name: string, fn: (store: MetadataStore) => Promise<void>): Promise<void> => {
    const store = await options.createStore();
    await fn(store);
    checks.push({ name, passed: true });
  };

  await check("missing get returns null", async (store) => {
    equal(await store.get("missing", 1), null, "missing metadata must return null");
  });

  await check("save assigns revision and returns detached records", async (store) => {
    const saved = await store.save(metadataRecord("meta.a", 1));
    equal(saved.revision, 1, "first metadata revision must be 1");
    const loaded = await store.get("meta.a", 1);
    assert(loaded, "saved metadata must be readable");
    deepEqual(loaded, saved, "metadata must round-trip");
    (loaded.snapshot.attributes[0] as { type: string }).type = "tampered";
    equal((await store.get("meta.a", 1))?.snapshot.attributes[0]?.type, "string", "reads must be detached");
  });

  await check("optimistic save and stale rejection", async (store) => {
    const first = await store.save(metadataRecord("meta.update", 1));
    const second = await store.save({ ...first, status: "published", updatedAt: "2026-01-02T00:00:00.000Z" }, first.revision);
    equal(second.revision, 2, "metadata update must increment revision");
    equal(second.createdAt, first.createdAt, "metadata update must preserve createdAt");
    await rejects(
      () => store.save({ ...second, status: "deprecated" }, first.revision),
      "stale metadata save must reject",
    );
    equal((await store.get("meta.update", 1))?.status, "published", "stale save must preserve current state");
  });

  await check("batch writes are atomic and ordered", async (store) => {
    const existing = await store.save(metadataRecord("meta.batch.existing", 1));
    const results = await store.saveBatch([
      { record: metadataRecord("meta.batch.new", 1) },
      { record: { ...existing, status: "published" }, expectedRevision: existing.revision },
    ]);
    deepEqual(results.map((record) => record.objectTypeId), ["meta.batch.new", "meta.batch.existing"], "metadata batch result order must match request order");
    const before = await store.get("meta.batch.existing", 1);
    await rejects(
      () => store.saveBatch([
        { record: metadataRecord("meta.atomic.new", 1) },
        { record: { ...existing, status: "deprecated" }, expectedRevision: existing.revision },
      ]),
      "metadata batch containing stale write must reject",
    );
    equal(await store.get("meta.atomic.new", 1), null, "failed metadata batch must roll back inserts");
    deepEqual(await store.get("meta.batch.existing", 1), before, "failed metadata batch must roll back updates");
  });

  await check("list filters by object type and status", async (store) => {
    await store.save(metadataRecord("meta.list", 1, "draft"));
    await store.save(metadataRecord("meta.list", 2, "published"));
    await store.save(metadataRecord("meta.other", 1, "published"));
    const byType = await store.list({ objectTypeId: "meta.list" });
    deepEqual(byType.map((record) => record.objectTypeVersion), [1, 2], "object type filter must retain matching versions");
    const published = await store.list({ status: "published" });
    deepEqual(published.map((record) => record.objectTypeId), ["meta.list", "meta.other"], "status filter must retain matching records");
  });

  await check("delete is optimistic and missing delete is idempotent", async (store) => {
    const saved = await store.save(metadataRecord("meta.delete", 1));
    await rejects(() => store.delete("meta.delete", 1, saved.revision + 1), "stale metadata delete must reject");
    assert(await store.get("meta.delete", 1), "stale delete must preserve metadata");
    await store.delete("meta.delete", 1, saved.revision);
    equal(await store.get("meta.delete", 1), null, "successful metadata delete must remove record");
    await store.delete("meta.delete", 1, saved.revision);
  });

  return { contract: "MetadataStore", checks };
}
