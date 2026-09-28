import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
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
const DATASET_SIZE = 1_200;
const CONCURRENT_READS = 400;
const CONTENTION_WRITERS = 32;
const MIGRATION_INITIALIZERS = 16;
const MAX_SEED_MS = Number(process.env.M74_MAX_SEED_MS ?? 30_000);
const MAX_QUERY_MATRIX_MS = Number(process.env.M74_MAX_QUERY_MATRIX_MS ?? 30_000);
const MAX_POOL_PRESSURE_MS = Number(process.env.M74_MAX_POOL_PRESSURE_MS ?? 30_000);
const MAX_CONTENTION_MS = Number(process.env.M74_MAX_CONTENTION_MS ?? 30_000);
const MAX_MIGRATION_STAMPEDE_MS = Number(process.env.M74_MAX_MIGRATION_STAMPEDE_MS ?? 30_000);

function tableName(suffix) {
  return `m74_${suffix}_${process.pid}`;
}

function createCertificationPool(connectionLimit = 8) {
  return createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

function certificationSnapshot(index) {
  return {
    id: `item-${String(index).padStart(4, "0")}`,
    type: "certification.item",
    schemaVersion: 1,
    version: 0,
    values: {
      sequence: index,
      group: `group-${index % 12}`,
      status: index % 4 === 0 ? "open" : index % 4 === 1 ? "closed" : index % 4 === 2 ? "pending" : "review",
      optional: index % 5 === 0 ? null : index % 7 === 0 ? undefined : `value-${index % 17}`,
      label: `Item ${String(index).padStart(4, "0")}`,
    },
    relationships: {},
  };
}

function metadataRecord(index) {
  const id = `certification.metadata.${String(index).padStart(3, "0")}`;
  const timestamp = "2026-09-27T21:45:00.000Z";
  return {
    objectTypeId: id,
    objectTypeVersion: 1,
    status: "draft",
    revision: 0,
    snapshot: normalizeObjectType({
      id,
      name: id,
      version: 1,
      attributes: { value: { type: "string" } },
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function elapsedSince(start) {
  return performance.now() - start;
}

function assertWithin(elapsed, maximum, label) {
  assert.ok(Number.isFinite(elapsed));
  assert.ok(elapsed <= maximum, `${label} took ${elapsed.toFixed(1)}ms, exceeding ${maximum}ms guardrail`);
}

function report(payload) {
  console.log(`M74_CERTIFICATION ${JSON.stringify(payload)}`);
}

async function sortedIds(adapter, query) {
  return (await adapter.query(query)).map((item) => item.id);
}

test("M74 large-dataset MySQL query semantics remain equivalent to the memory reference", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(8);
  const table = tableName("equivalence");
  const ledger = tableName("equivalence_ledger");
  const mysqlAdapter = new MySqlStorageAdapter(pool, {
    tableName: table,
    migrations: { migrationTableName: ledger, lockTimeoutSeconds: 15 },
  });
  const memoryAdapter = new MemoryStorageAdapter();

  try {
    await mysqlAdapter.initialize();
    const snapshots = Array.from({ length: DATASET_SIZE }, (_, index) => certificationSnapshot(index));
    const batch = snapshots.map((snapshot) => ({ kind: "insert", snapshot }));

    const seedStart = performance.now();
    await mysqlAdapter.saveBatch(batch);
    await memoryAdapter.saveBatch(batch);
    const seedMs = elapsedSince(seedStart);
    assertWithin(seedMs, MAX_SEED_MS, `${DATASET_SIZE}-object seed`);

    const queries = [
      { objectType: "certification.item", where: [{ attribute: "status", operator: "eq", value: "open" }] },
      { objectType: "certification.item", where: [{ attribute: "status", operator: "neq", value: "closed" }] },
      { objectType: "certification.item", where: [{ attribute: "status", operator: "in", value: ["open", "pending"] }] },
      { objectType: "certification.item", where: [{ attribute: "status", operator: "notIn", value: ["review"] }] },
      { objectType: "certification.item", where: [{ attribute: "optional", operator: "isNull" }] },
      { objectType: "certification.item", where: [{ attribute: "optional", operator: "isNotNull" }] },
      { objectType: "certification.item", where: [{ attribute: "sequence", operator: "gte", value: 600 }] },
      { objectType: "certification.item", where: [{ attribute: "sequence", operator: "lt", value: 100 }] },
      { objectType: "certification.item", where: [{ attribute: "label", operator: "contains", value: "01" }] },
      { objectType: "certification.item", where: [{ attribute: "label", operator: "startsWith", value: "Item 00" }] },
      { objectType: "certification.item", where: [{ attribute: "label", operator: "endsWith", value: "5" }] },
      { objectType: "certification.item", orderBy: [{ attribute: "sequence", direction: "desc" }], limit: 25 },
      { objectType: "certification.item", where: [{ attribute: "status", operator: "eq", value: "pending" }], limit: 25, offset: 20 },
      { objectType: "certification.item", where: [{ attribute: "sequence", operator: "gte", value: 300 }], orderBy: [{ attribute: "label", direction: "asc" }], limit: 30 },
      { objectType: "certification.item", where: [{ attribute: "optional", operator: "eq", value: undefined }] },
      { objectType: "certification.item", where: [{ attribute: "optional", operator: "eq", value: null }] },
    ];

    const matrixStart = performance.now();
    for (const query of queries) {
      assert.deepEqual(await sortedIds(mysqlAdapter, query), await sortedIds(memoryAdapter, query));
    }
    const queryMatrixMs = elapsedSince(matrixStart);
    assertWithin(queryMatrixMs, MAX_QUERY_MATRIX_MS, `${queries.length}-query equivalence matrix`);

    report({ test: "large-dataset-equivalence", datasetSize: DATASET_SIZE, queryCount: queries.length, seedMs: Number(seedMs.toFixed(1)), queryMatrixMs: Number(queryMatrixMs.toFixed(1)) });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledger}\``);
    await pool.end();
  }
});

test("M74 small-pool read pressure drains without leaks or queue residue", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(4);
  const table = tableName("pool_pressure");
  const ledger = tableName("pool_pressure_ledger");
  const adapter = new MySqlStorageAdapter(pool, { tableName: table, migrations: { migrationTableName: ledger } });

  try {
    await adapter.initialize();
    await adapter.saveBatch(Array.from({ length: 100 }, (_, index) => ({ kind: "insert", snapshot: certificationSnapshot(index) })));
    const start = performance.now();
    await Promise.all(Array.from({ length: CONCURRENT_READS }, (_, index) => adapter.get({ type: "certification.item", id: `item-${String(index % 100).padStart(4, "0")}` })));
    const pressureMs = elapsedSince(start);
    assertWithin(pressureMs, MAX_POOL_PRESSURE_MS, `${CONCURRENT_READS} reads through four connections`);

    const health = await pool.healthCheck();
    assert.equal(health.ok, true);
    const stats = pool.stats();
    assert.equal(stats.queued, 0);
    assert.equal(stats.active, 0);
    assert.ok(stats.total <= stats.limit);

    report({ test: "pool-pressure", concurrentReads: CONCURRENT_READS, poolLimit: stats.limit, pressureMs: Number(pressureMs.toFixed(1)) });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledger}\``);
    await pool.end();
  }
});

test("M74 optimistic concurrency has one winner under high object and metadata contention", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(8);
  const objectTable = tableName("object_contention");
  const metadataTable = tableName("metadata_contention");
  const ledgerTable = tableName("contention_ledger");
  const migrationOptions = { migrationTableName: ledgerTable, lockTimeoutSeconds: 15 };
  const adapter = new MySqlStorageAdapter(pool, { tableName: objectTable, migrations: migrationOptions });
  const store = new MySqlMetadataStore(pool, { tableName: metadataTable, migrations: migrationOptions });

  try {
    await adapter.initialize();
    await store.initialize();
    const base = await adapter.insert(certificationSnapshot(0));
    const metadataBase = await store.save(metadataRecord(0));

    const start = performance.now();
    const objectResults = await Promise.allSettled(Array.from({ length: CONTENTION_WRITERS }, (_, index) => adapter.update({ ...base, values: { ...base.values, contender: index } }, base.version)));
    const metadataResults = await Promise.allSettled(Array.from({ length: CONTENTION_WRITERS }, (_, index) => store.save({ ...metadataBase, updatedAt: `2026-09-27T21:45:${String(index).padStart(2, "0")}.000Z` }, metadataBase.revision)));
    const contentionMs = elapsedSince(start);
    assertWithin(contentionMs, MAX_CONTENTION_MS, `${CONTENTION_WRITERS}-way object+metadata contention`);

    const objectWinners = objectResults.filter((result) => result.status === "fulfilled");
    const objectLosers = objectResults.filter((result) => result.status === "rejected");
    assert.equal(objectWinners.length, 1);
    assert.equal(objectLosers.length, CONTENTION_WRITERS - 1);
    assert.ok(objectLosers.every((result) => result.reason?.name === "ConcurrencyError"));

    const metadataWinners = metadataResults.filter((result) => result.status === "fulfilled");
    const metadataLosers = metadataResults.filter((result) => result.status === "rejected");
    assert.equal(metadataWinners.length, 1);
    assert.equal(metadataLosers.length, CONTENTION_WRITERS - 1);
    assert.ok(metadataLosers.every((result) => result.reason?.name === "ConcurrencyError"));

    report({ test: "contention", contenders: CONTENTION_WRITERS, objectWinners: objectWinners.length, objectConflicts: objectLosers.length, metadataWinners: metadataWinners.length, metadataConflicts: metadataLosers.length, contentionMs: Number(contentionMs.toFixed(1)) });
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${metadataTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});

test("M74 large transactional batches roll back all earlier writes after a stale write", { skip: !configured, timeout: 120_000 }, async () => {
  const pool = createCertificationPool(8);
  const objectTable = tableName("rollback_objects");
  const metadataTable = tableName("rollback_metadata");
  const ledgerTable = tableName("rollback_ledger");
  const migrationOptions = { migrationTableName: ledgerTable };
  const adapter = new MySqlStorageAdapter(pool, { tableName: objectTable, migrations: migrationOptions });
  const store = new MySqlMetadataStore(pool, { tableName: metadataTable, migrations: migrationOptions });

  try {
    await adapter.initialize();
    await store.initialize();
    const objectBases = await adapter.saveBatch(Array.from({ length: 24 }, (_, index) => ({ kind: "insert", snapshot: certificationSnapshot(index) })));
    const metadataBases = await store.saveBatch(Array.from({ length: 16 }, (_, index) => ({ record: metadataRecord(index) })));

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
