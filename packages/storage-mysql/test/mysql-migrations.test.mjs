import assert from "node:assert/strict";
import test from "node:test";
import NuBloxSQL from "nubloxsql";
import {
  MYSQL_IDENTITY_COLLATION,
  MYSQL_METADATA_SCHEMA_VERSION,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MySqlStorageAdapter,
  createMetadataTableV1Sql,
  createMetadataV2MigrationSql,
  createStorageTableV1Sql,
  createStorageV2MigrationSql,
  migrateMySqlMetadataSchema,
  migrateMySqlStorageSchema,
} from "../dist/index.js";

const { createPool } = NuBloxSQL.mysql;
const configured = Boolean(process.env.MYSQL_HOST);

function name(suffix) {
  return `m79_${suffix}_${process.pid}`;
}

async function columnCollations(pool, tableName, columns) {
  const { rows } = await pool.execute(
    `SELECT COLUMN_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME IN (${columns.map(() => "?").join(", ")})
      ORDER BY COLUMN_NAME`,
    [tableName, ...columns],
  );
  return Object.fromEntries(rows.map((row) => [String(row.COLUMN_NAME), String(row.COLLATION_NAME)]));
}

test("M73/M79 versioned schema migrations are recoverable, serialized, drift-aware and exact-identity safe", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 8,
  });

  const migrationTableName = name("ledger");
  const tables = [migrationTableName];
  const options = { migrationTableName, lockTimeoutSeconds: 10 };

  try {
    const freshStorage = name("fresh_storage");
    tables.push(freshStorage);
    const fresh = await migrateMySqlStorageSchema(pool, freshStorage, options);
    assert.equal(fresh.schemaVersion, MYSQL_STORAGE_SCHEMA_VERSION);
    assert.deepEqual(fresh.appliedVersions, [1, 2, 3]);
    assert.deepEqual(fresh.adoptedVersions, []);
    assert.deepEqual(
      await columnCollations(pool, freshStorage, ["object_id", "object_type"]),
      { object_id: MYSQL_IDENTITY_COLLATION, object_type: MYSQL_IDENTITY_COLLATION },
    );

    const freshAgain = await migrateMySqlStorageSchema(pool, freshStorage, options);
    assert.deepEqual(freshAgain.appliedVersions, []);
    assert.deepEqual(freshAgain.adoptedVersions, []);

    const legacyStorage = name("legacy_storage");
    tables.push(legacyStorage);
    await pool.query(createStorageTableV1Sql(legacyStorage));
    const upgradedStorage = await migrateMySqlStorageSchema(pool, legacyStorage, options);
    assert.deepEqual(upgradedStorage.adoptedVersions, [1]);
    assert.deepEqual(upgradedStorage.appliedVersions, [2, 3]);

    const legacyStorageV2 = name("legacy_storage_v2");
    tables.push(legacyStorageV2);
    await pool.query(createStorageTableV1Sql(legacyStorageV2));
    await pool.query(createStorageV2MigrationSql(legacyStorageV2));
    const upgradedStorageV2 = await migrateMySqlStorageSchema(pool, legacyStorageV2, options);
    assert.deepEqual(upgradedStorageV2.adoptedVersions, [1, 2]);
    assert.deepEqual(upgradedStorageV2.appliedVersions, [3]);
    assert.deepEqual(
      await columnCollations(pool, legacyStorageV2, ["object_id", "object_type"]),
      { object_id: MYSQL_IDENTITY_COLLATION, object_type: MYSQL_IDENTITY_COLLATION },
    );

    const legacyMetadata = name("legacy_metadata");
    tables.push(legacyMetadata);
    await pool.query(createMetadataTableV1Sql(legacyMetadata));
    const upgradedMetadata = await migrateMySqlMetadataSchema(pool, legacyMetadata, options);
    assert.equal(upgradedMetadata.schemaVersion, MYSQL_METADATA_SCHEMA_VERSION);
    assert.deepEqual(upgradedMetadata.adoptedVersions, [1]);
    assert.deepEqual(upgradedMetadata.appliedVersions, [2, 3]);
    assert.deepEqual(
      await columnCollations(pool, legacyMetadata, ["object_type_id"]),
      { object_type_id: MYSQL_IDENTITY_COLLATION },
    );

    const legacyMetadataV2 = name("legacy_metadata_v2");
    tables.push(legacyMetadataV2);
    await pool.query(createMetadataTableV1Sql(legacyMetadataV2));
    await pool.query(createMetadataV2MigrationSql(legacyMetadataV2));
    const upgradedMetadataV2 = await migrateMySqlMetadataSchema(pool, legacyMetadataV2, options);
    assert.deepEqual(upgradedMetadataV2.adoptedVersions, [1, 2]);
    assert.deepEqual(upgradedMetadataV2.appliedVersions, [3]);

    const concurrentTable = name("concurrent");
    tables.push(concurrentTable);
    const left = new MySqlStorageAdapter(pool, { tableName: concurrentTable, migrations: options });
    const right = new MySqlStorageAdapter(pool, { tableName: concurrentTable, migrations: options });
    await Promise.all([left.initialize(), right.initialize()]);
    const { rows: concurrentLedger } = await pool.execute(
      `SELECT schema_version
         FROM \`${migrationTableName}\`
        WHERE component = ? AND target_table = ?
        ORDER BY schema_version`,
      ["storage", concurrentTable],
    );
    assert.deepEqual(concurrentLedger.map((row) => Number(row.schema_version)), [1, 2, 3]);

    const driftTable = name("drift");
    tables.push(driftTable);
    await pool.query(createStorageTableV1Sql(driftTable));
    await pool.query(`ALTER TABLE \`${driftTable}\` MODIFY schema_version BIGINT UNSIGNED NOT NULL`);
    await assert.rejects(
      () => migrateMySqlStorageSchema(pool, driftTable, options),
      /schema drift detected.*schema_version/s,
    );

    const tamperTable = name("tamper");
    tables.push(tamperTable);
    await migrateMySqlStorageSchema(pool, tamperTable, options);
    await pool.execute(
      `UPDATE \`${migrationTableName}\`
          SET checksum = ?
        WHERE component = ? AND target_table = ? AND schema_version = 1`,
      ["0".repeat(64), "storage", tamperTable],
    );
    await assert.rejects(
      () => migrateMySqlStorageSchema(pool, tamperTable, options),
      /migration ledger integrity mismatch at version 1/,
    );
  } finally {
    for (const tableName of tables.reverse()) {
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.end();
  }
});
