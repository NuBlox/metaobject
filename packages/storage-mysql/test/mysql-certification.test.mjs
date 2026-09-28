import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createPool } from "@nublox/mysql/promise";
import {
  MemoryStorageAdapter,
  normalizeObjectType,
} from "@nublox/metaobject";
import {
  MySqlMetadataStore,
  MySqlStorageAdapter,
} from "../dist/index.js";

const configured = Boolean(process.env.MYSQL_HOST);
const DATASET_SIZE = Number(process.env.M74_DATASET_SIZE ?? 1200);
const PARALLEL_READS = Number(process.env.M74_PARALLEL_READS ?? 400);
const CONTENTION_WRITERS = Number(process.env.M74_CONTENTION_WRITERS ?? 32);
const MIGRATION_INITIALIZERS = Number(process.env.M74_MIGRATION_INITIALIZERS ?? 16);
const MAX_SEED_MS = Number(process.env.M74_MAX_SEED_MS ?? 30_000);
const MAX_QUERY_MATRIX_MS = Number(process.env.M74_MAX_QUERY_MATRIX_MS ?? 15_000);
const MAX_PARALLEL_READ_MS = Number(process.env.M74_MAX_PARALLEL_READ_MS ?? 15_000);
const MAX_CONTENTION_MS = Number(process.env.M74_MAX_CONTENTION_MS ?? 20_000);
const MAX_MIGRATION_STAMPEDE_MS = Number(process.env.M74_MAX_MIGRATION_STAMPEDE_MS ?? 20_000);

function tableName(suffix) {
  return `m74_${suffix}_${process.pid}`;
}

function snapshot(index) {
  return {
    id: `object-${String(index).padStart(5, "0")}`,
    type: "certification.item",
    schemaVersion: 1,
    version: 0,
    values: {
      ordinal: index,
      bucket: `bucket-${index % 7}`,
      active: index % 2 === 0,
      nullable: index % 5 === 0 ? null : index % 11 === 0 ? undefined : `nullable-${index % 13}`,
      score: index % 97 === 0 ? Number.NaN : index % 101 === 0 ? Infinity : index % 103 === 0 ? -0 : index % 29,
      text: `item-${String(index).padStart(5, "0")}-group-${index % 17}`,
    },
    relationships: {},
  };
}

function metadataRecord(index, status = "draft") {
  const id = `certification.metadata.${String(index).padStart(4, "0")}`;
  const timestamp = "2026-09-27T21:45:00.000Z";
  return {
    objectTypeId: id,
    objectTypeVersion: 1,
    status,
    revision: 0,
    snapshot: normalizeObjectType({
      id,
      name: id,
      version: 1,
      attributes: {
        value: { type: "string" },
      },
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function ids(items) {
  return items.map((item) => item.id);
}

function elapsedSince(start) {
  return performance.now() - start;
}

function assertWithin(actualMs, maximumMs, label) {
  assert.ok(
    actualMs <= maximumMs,
    `${label} took ${actualMs.toFixed(1)}ms; M74 guardrail is ${maximumMs}ms`,
  );
}

function report(metrics) {
  process.stdout.write(`M74_CERTIFICATION ${JSON.stringify(metrics)}\n`);
}

function createCertificationPool(connectionLimit = 8) {
  return createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit,
    queueLimit: 0,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

test("M74 large-dataset query semantics match the reference adapter under pool pressure", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(4);
  const objectTable = tableName("equivalence");
  const ledgerTable = tableName("equivalence_ledger");
  const adapter = new MySqlStorageAdapter(pool, {
    tableName: objectTable,
    migrations: { migrationTableName: ledgerTable, lockTimeoutSeconds: 10 },
  });
  const reference = new MemoryStorageAdapter();

  try {
    await adapter.initialize();
    const source = Array.from({ length: DATASET_SIZE }, (_, index) => snapshot(index));
    const writes = source.map((item) => ({ kind: "insert", snapshot: item }));

    const referenceStart = performance.now();
    await reference.saveBatch(writes);
    const referenceSeedMs = elapsedSince(referenceStart);

    const mysqlStart = performance.now();
    await adapter.saveBatch(writes);
    const mysqlSeedMs = elapsedSince(mysqlStart);
    assertWithin(mysqlSeedMs, MAX_SEED_MS, `seeding ${DATASET_SIZE} MySQL objects`);

    const queries = [
      { objectType: "certification.item", limit: 25 },
      { objectType: "certification.item", offset: 31, limit: 17 },
      { objectType: "certification.item", offset: 57 },
      { objectType: "certification.item", where: [{ attribute: "bucket", operator: "eq", value: "bucket-3" }] },
      { objectType: "certification.item", where: [{ attribute: "active", operator: "neq", value: true }] },
      { objectType: "certification.item", where: [{ attribute: "bucket", operator: "in", value: ["bucket-1", "bucket-5"] }] },
      { objectType: "certification.item", where: [{ attribute: "bucket", operator: "notIn", value: ["bucket-0", "bucket-6"] }] },
      { objectType: "certification.item", where: [{ attribute: "nullable", operator: "isNull" }] },
      { objectType: "certification.item", where: [{ attribute: "nullable", operator: "isNotNull" }] },
      { objectType: "certification.item", where: [{ attribute: "nullable", operator: "eq", value: undefined }] },
      { objectType: "certification.item", where: [{ attribute: "score", operator: "eq", value: Number.NaN }] },
      {
        objectType: "certification.item",
        where: [{ attribute: "ordinal", operator: "gte", value: Math.floor(DATASET_SIZE * 0.75) }],
        orderBy: [{ attribute: "ordinal", direction: "desc" }],
        limit: 23,
      },
      { objectType: "certification.item", where: [{ attribute: "text", operator: "contains", value: "group-12" }] },
      { objectType: "certification.item", where: [{ attribute: "text", operator: "startsWith", value: "item-000" }] },
      { objectType: "certification.item", where: [{ attribute: "text", operator: "endsWith", value: "group-7" }] },
      {
        objectType: "certification.item",
        where: [
          { attribute: "bucket", operator: "eq", value: "bucket-2" },
          { attribute: "nullable", operator: "isNotNull" },
        ],
        limit: 40,
      },
    ];

    const queryStart = performance.now();
    for (const query of queries) {
      const [expected, actual] = await Promise.all([
        reference.query(query),
        adapter.query(query),
      ]);
      assert.deepEqual(ids(actual), ids(expected), `query mismatch for ${JSON.stringify(query)}`);
    }
    const queryMatrixMs = elapsedSince(queryStart);
    assertWithin(queryMatrixMs, MAX_QUERY_MATRIX_MS, `${queries.length}-query semantic matrix`);

    const readStart = performance.now();
    const reads = Array.from({ length: PARALLEL_READS }, (_, index) =>
      adapter.get({ type: "certification.item", id: `object-${String(index % DATASET_SIZE).padStart(5, "0")}` }),
    );
    const loaded = await Promise.all(reads);
    const parallelReadMs = elapsedSince(readStart);
    assert.equal(loaded.length, PARALLEL_READS);
    assert.ok(loaded.every(Boolean));
    assertWithin(parallelReadMs, MAX_PARALLEL_READ_MS, `${PARALLEL_READS} pooled parallel reads`);

    const health = await pool.healthCheck();
    assert.equal(health.ok, true);
    const stats = pool.stats();
    assert.equal(stats.queued, 0, "pool queue must drain after certification reads");
    assert.equal(stats.active, 0, "pool connections must return after certification reads");
    assert.ok(stats.total <= stats.limit, "pool must not exceed configured connection limit");

    report({
      test: "query-equivalence",
      datasetSize: DATASET_SIZE,
      queries: queries.length,
      parallelReads: PARALLEL_READS,
      referenceSeedMs: Number(referenceSeedMs.toFixed(1)),
      mysqlSeedMs: Number(mysqlSeedMs.toFixed(1)),
      queryMatrixMs: Number(queryMatrixMs.toFixed(1)),
      parallelReadMs: Number(parallelReadMs.toFixed(1)),
      poolLimit: stats.limit,
      poolTotal: stats.total,
    });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});

test("M74 contention preserves single-winner optimistic concurrency for objects and metadata", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(8);
  const objectTable = tableName("contention_objects");
  const metadataTable = tableName("contention_metadata");
  const ledgerTable = tableName("contention_ledger");
  const migrationOptions = { migrationTableName: ledgerTable, lockTimeoutSeconds: 10 };
  const adapter = new MySqlStorageAdapter(pool, { tableName: objectTable, migrations: migrationOptions });
  const store = new MySqlMetadataStore(pool, { tableName: metadataTable, migrations: migrationOptions });

  try {
    await Promise.all([adapter.initialize(), store.initialize()]);
    const objectBase = await adapter.insert(snapshot(0));
    const metadataBase = await store.save(metadataRecord(0));

    const start = performance.now();
    const objectResults = await Promise.allSettled(
      Array.from({ length: CONTENTION_WRITERS }, (_, writer) =>
        adapter.update(
          { ...objectBase, values: { ...objectBase.values, writer } },
          objectBase.version,
        ),
      ),
    );
    const objectFulfilled = objectResults.filter((result) => result.status === "fulfilled");
    const objectRejected = objectResults.filter((result) => result.status === "rejected");
    assert.equal(objectFulfilled.length, 1, "exactly one object contender must commit");
    assert.equal(objectRejected.length, CONTENTION_WRITERS - 1);
    assert.ok(objectRejected.every((result) => result.reason?.name === "ConcurrencyError"));
    const currentObject = await adapter.get(objectBase);
    assert.ok(currentObject);
    assert.equal(currentObject.version, 2);
    assert.equal(currentObject.values.writer, objectFulfilled[0].value.values.writer);

    const metadataResults = await Promise.allSettled(
      Array.from({ length: CONTENTION_WRITERS }, (_, writer) =>
        store.save(
          {
            ...metadataBase,
            status: writer % 2 === 0 ? "published" : "deprecated",
            updatedAt: `2026-09-27T21:45:${String(writer % 60).padStart(2, "0")}.000Z`,
          },
          metadataBase.revision,
        ),
      ),
    );
    const metadataFulfilled = metadataResults.filter((result) => result.status === "fulfilled");
    const metadataRejected = metadataResults.filter((result) => result.status === "rejected");
    assert.equal(metadataFulfilled.length, 1, "exactly one metadata contender must commit");
    assert.equal(metadataRejected.length, CONTENTION_WRITERS - 1);
    assert.ok(metadataRejected.every((result) => result.reason?.name === "ConcurrencyError"));
    const currentMetadata = await store.get(metadataBase.objectTypeId, metadataBase.objectTypeVersion);
    assert.ok(currentMetadata);
    assert.equal(currentMetadata.revision, 2);
    assert.equal(currentMetadata.status, metadataFulfilled[0].value.status);

    const contentionMs = elapsedSince(start);
    assertWithin(contentionMs, MAX_CONTENTION_MS, `${CONTENTION_WRITERS}-way object and metadata contention`);

    const health = await pool.healthCheck();
    assert.equal(health.ok, true);
    const stats = pool.stats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.active, 0);

    report({
      test: "contention",
      writers: CONTENTION_WRITERS,
      objectLosers: objectRejected.length,
      metadataLosers: metadataRejected.length,
      contentionMs: Number(contentionMs.toFixed(1)),
    });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${metadataTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});

test("M74 large failed batches roll back atomically for object and metadata persistence", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(6);
  const objectTable = tableName("rollback_objects");
  const metadataTable = tableName("rollback_metadata");
  const ledgerTable = tableName("rollback_ledger");
  const migrationOptions = { migrationTableName: ledgerTable, lockTimeoutSeconds: 10 };
  const adapter = new MySqlStorageAdapter(pool, { tableName: objectTable, migrations: migrationOptions });
  const store = new MySqlMetadataStore(pool, { tableName: metadataTable, migrations: migrationOptions });

  try {
    await Promise.all([adapter.initialize(), store.initialize()]);
    const objectBases = await adapter.saveBatch(
      Array.from({ length: 40 }, (_, index) => ({ kind: "insert", snapshot: snapshot(index) })),
    );
    const metadataBases = await store.saveBatch(
      Array.from({ length: 24 }, (_, index) => ({ record: metadataRecord(index) })),
    );

    const objectWrites = objectBases.slice(0, 20).map((item, index) => ({
      kind: "update",
      snapshot: { ...item, values: { ...item.values, rollbackProbe: index } },
      expectedVersion: item.version,
    }));
    objectWrites.push({
      kind: "update",
      snapshot: { ...objectBases[20], values: { ...objectBases[20].values, rollbackProbe: "stale" } },
      expectedVersion: 0,
    });
    await assert.rejects(() => adapter.saveBatch(objectWrites), (error) => error?.name === "ConcurrencyError");

    for (const base of objectBases.slice(0, 20)) {
      const current = await adapter.get(base);
      assert.ok(current);
      assert.equal(current.version, 1, `object '${base.id}' must roll back to version 1`);
      assert.equal(Object.prototype.hasOwnProperty.call(current.values, "rollbackProbe"), false);
    }

    const metadataWrites = metadataBases.slice(0, 12).map((item, index) => ({
      record: {
        ...item,
        status: index % 2 === 0 ? "published" : "deprecated",
        updatedAt: `2026-09-27T21:46:${String(index).padStart(2, "0")}.000Z`,
      },
      expectedRevision: item.revision,
    }));
    metadataWrites.push({
      record: {
        ...metadataBases[12],
        status: "published",
        updatedAt: "2026-09-27T21:46:59.000Z",
      },
      expectedRevision: 0,
    });
    await assert.rejects(() => store.saveBatch(metadataWrites), (error) => error?.name === "ConcurrencyError");

    for (const base of metadataBases.slice(0, 12)) {
      const current = await store.get(base.objectTypeId, base.objectTypeVersion);
      assert.ok(current);
      assert.equal(current.revision, 1, `metadata '${base.objectTypeId}' must roll back to revision 1`);
      assert.equal(current.status, "draft");
    }

    const health = await pool.healthCheck();
    assert.equal(health.ok, true);
    const stats = pool.stats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.active, 0);

    report({
      test: "atomic-rollback",
      objectWritesBeforeFailure: 20,
      metadataWritesBeforeFailure: 12,
    });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${metadataTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});

test("M74 migration initialization remains idempotent under a connection-pool stampede", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(6);
  const objectTable = tableName("migration_stampede");
  const ledgerTable = tableName("migration_stampede_ledger");
  const migrationOptions = { migrationTableName: ledgerTable, lockTimeoutSeconds: 15 };

  try {
    const adapters = Array.from(
      { length: MIGRATION_INITIALIZERS },
      () => new MySqlStorageAdapter(pool, { tableName: objectTable, migrations: migrationOptions }),
    );
    const start = performance.now();
    await Promise.all(adapters.map((adapter) => adapter.initialize()));
    const migrationStampedeMs = elapsedSince(start);
    assertWithin(
      migrationStampedeMs,
      MAX_MIGRATION_STAMPEDE_MS,
      `${MIGRATION_INITIALIZERS} concurrent migration initializers`,
    );

    const [ledgerRows] = await pool.execute(
      `SELECT schema_version, COUNT(*) AS row_count
         FROM \`${ledgerTable}\`
        WHERE component = ? AND target_table = ?
        GROUP BY schema_version
        ORDER BY schema_version`,
      ["storage", objectTable],
    );
    assert.deepEqual(
      ledgerRows.map((row) => [Number(row.schema_version), Number(row.row_count)]),
      [[1, 1], [2, 1], [3, 1]],
      "migration ledger must contain exactly one immutable row per schema version",
    );

    const health = await pool.healthCheck();
    assert.equal(health.ok, true);
    const stats = pool.stats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.active, 0);
    assert.ok(stats.total <= stats.limit);

    report({
      test: "migration-stampede",
      initializers: MIGRATION_INITIALIZERS,
      migrationStampedeMs: Number(migrationStampedeMs.toFixed(1)),
      poolLimit: stats.limit,
    });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});
