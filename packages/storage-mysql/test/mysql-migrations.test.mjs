import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@nublox/mysql/promise";
import {
  MYSQL_METADATA_SCHEMA_VERSION,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MySqlStorageAdapter,
  createMetadataTableV1Sql,
  createStorageTableV1Sql,
  migrateMySqlMetadataSchema,
  migrateMySqlStorageSchema,
} from "../dist/index.js";

const configured = Boolean(process.env.MYSQL_HOST);

function name(suffix) {
  return `m73_${suffix}_${process.pid}`;
}

test("M73 versioned schema migrations are recoverable, serialized and drift-aware", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 8,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const migrationTableName = name("ledger");
  const tables = [migrationTableName];
  const options = { migrationTableName, lockTimeoutSeconds: 10 };

  try {
    const freshStorage = name("fresh_storage");
    tables.push(freshStorage);
    const fresh = await migrateMySqlStorageSchema(pool, freshStorage, options);
    assert.equal(fresh.schemaVersion, MYSQL_STORAGE_SCHEMA_VERSION);
    assert.deepEqual(fresh.appliedVersions, [1, 2]);
    assert.deepEqual(fresh.adoptedVersions, []);

    const freshAgain = await migrateMySqlStorageSchema(pool, freshStorage, options);
    assert.deepEqual(freshAgain.appliedVersions, []);
    assert.deepEqual(freshAgain.adoptedVersions, []);

    const legacyStorage = name("legacy_storage");
    tables.push(legacyStorage);
    await pool.query(createStorageTableV1Sql(legacyStorage));
    const upgradedStorage = await migrateMySqlStorageSchema(pool, legacyStorage, options);
    assert.deepEqual(upgradedStorage.adoptedVersions, [1]);
    assert.deepEqual(upgradedStorage.appliedVersions, [2]);

    const legacyMetadata = name("legacy_metadata");
    tables.push(legacyMetadata);
    await pool.query(createMetadataTableV1Sql(legacyMetadata));
    const upgradedMetadata = await migrateMySqlMetadataSchema(pool, legacyMetadata, options);
    assert.equal(upgradedMetadata.schemaVersion, MYSQL_METADATA_SCHEMA_VERSION);
    assert.deepEqual(upgradedMetadata.adoptedVersions, [1]);
    assert.deepEqual(upgradedMetadata.appliedVersions, [2]);

    const concurrentTable = name("concurrent");
    tables.push(concurrentTable);
    const left = new MySqlStorageAdapter(pool, { tableName: concurrentTable, migrations: options });
    const right = new MySqlStorageAdapter(pool, { tableName: concurrentTable, migrations: options });
    await Promise.all([left.initialize(), right.initialize()]);
    const [concurrentLedger] = await pool.execute(
      `SELECT schema_version
         FROM \`${migrationTableName}\`
        WHERE component = ? AND target_table = ?
        ORDER BY schema_version`,
      ["storage", concurrentTable],
    );
    assert.deepEqual(concurrentLedger.map((row) => Number(row.schema_version)), [1, 2]);

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
