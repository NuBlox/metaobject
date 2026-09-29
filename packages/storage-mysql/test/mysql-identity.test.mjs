import assert from "node:assert/strict";
import test from "node:test";
import NuBloxSQL from "nubloxsql";
import { normalizeObjectType } from "@nublox/metaobject";
import { MySqlMetadataStore, MySqlStorageAdapter } from "../dist/index.js";

const { createPool } = NuBloxSQL.mysql;
const configured = Boolean(process.env.MYSQL_HOST);

function name(suffix) {
  return `m79_identity_${suffix}_${process.pid}`;
}

function snapshot(type, id, marker) {
  return {
    id,
    type,
    schemaVersion: 1,
    version: 0,
    values: { marker },
    relationships: {},
  };
}

function metadataRecord(id, marker) {
  const timestamp = "2026-09-28T01:30:00.000Z";
  return {
    objectTypeId: id,
    objectTypeVersion: 1,
    status: "draft",
    revision: 0,
    snapshot: normalizeObjectType({
      id,
      name: marker,
      version: 1,
      attributes: { value: { type: "string" } },
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("M79 MySQL identities match JavaScript case and trailing-space equality", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 6,
  });

  const objectTable = name("objects");
  const metadataTable = name("metadata");
  const ledgerTable = name("ledger");
  const migrations = { migrationTableName: ledgerTable, lockTimeoutSeconds: 10 };
  const storage = new MySqlStorageAdapter(pool, { tableName: objectTable, migrations });
  const metadata = new MySqlMetadataStore(pool, { tableName: metadataTable, migrations });

  try {
    await storage.initialize();
    await metadata.initialize();

    await storage.saveBatch([
      { kind: "insert", snapshot: snapshot("Identity.Type", "Key", "upper-type-upper-id") },
      { kind: "insert", snapshot: snapshot("identity.type", "Key", "lower-type") },
      { kind: "insert", snapshot: snapshot("Identity.Type", "key", "lower-id") },
      { kind: "insert", snapshot: snapshot("Identity.Type", "Key ", "trailing-space-id") },
    ]);

    assert.equal((await storage.get({ type: "Identity.Type", id: "Key" }))?.values.marker, "upper-type-upper-id");
    assert.equal((await storage.get({ type: "identity.type", id: "Key" }))?.values.marker, "lower-type");
    assert.equal((await storage.get({ type: "Identity.Type", id: "key" }))?.values.marker, "lower-id");
    assert.equal((await storage.get({ type: "Identity.Type", id: "Key " }))?.values.marker, "trailing-space-id");
    assert.equal(await storage.get({ type: "IDENTITY.TYPE", id: "Key" }), null);

    const exactType = await storage.query({ objectType: "Identity.Type" });
    assert.deepEqual(
      exactType.map((item) => item.id).sort(),
      ["Key", "Key ", "key"].sort(),
    );
    assert.deepEqual(
      (await storage.query({ objectType: "identity.type" })).map((item) => item.id),
      ["Key"],
    );

    await metadata.save(metadataRecord("Identity.Metadata", "upper-metadata"));
    await metadata.save(metadataRecord("identity.metadata", "lower-metadata"));
    await metadata.save(metadataRecord("Identity.Metadata ", "trailing-metadata"));

    assert.equal((await metadata.get("Identity.Metadata", 1))?.snapshot.objectType.name, "upper-metadata");
    assert.equal((await metadata.get("identity.metadata", 1))?.snapshot.objectType.name, "lower-metadata");
    assert.equal((await metadata.get("Identity.Metadata ", 1))?.snapshot.objectType.name, "trailing-metadata");
    assert.equal(await metadata.get("IDENTITY.METADATA", 1), null);

    assert.deepEqual(
      (await metadata.list({ objectTypeId: "Identity.Metadata" })).map((record) => record.objectTypeId),
      ["Identity.Metadata"],
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${objectTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${metadataTable}\``);
    await pool.query(`DROP TABLE IF EXISTS \`${ledgerTable}\``);
    await pool.end();
  }
});
