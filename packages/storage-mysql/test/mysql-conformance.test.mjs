import assert from "node:assert/strict";
import test from "node:test";
import NuBloxSQL from "nubloxsql";
import {
  normalizeObjectType,
  runMetadataStoreConformance,
  runStorageAdapterConformance,
} from "@nublox/metaobject";
import { MySqlMetadataStore, MySqlStorageAdapter } from "../dist/index.js";

const { createPool } = NuBloxSQL.mysql;
const configured = Boolean(process.env.MYSQL_HOST);

function snapshot(id, value = 1) {
  return {
    id,
    type: "conformance.race",
    schemaVersion: 1,
    version: 0,
    values: { value },
    relationships: {},
  };
}

function metadataRecord(id, version = 1, status = "draft") {
  const timestamp = "2026-09-27T20:00:00.000Z";
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

test("MySQL persistence satisfies MetaObject conformance and hardening", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    ssl: "disable",
    connectionLimit: 8,
  });
  const tables = [];
  let sequence = 0;

  const createAdapter = async () => {
    const tableName = `metaobject_object_${process.pid}_${sequence++}`;
    tables.push(tableName);
    const adapter = new MySqlStorageAdapter(pool, { tableName });
    await adapter.initialize();
    return adapter;
  };

  const createStore = async () => {
    const tableName = `metaobject_metadata_${process.pid}_${sequence++}`;
    tables.push(tableName);
    const store = new MySqlMetadataStore(pool, { tableName });
    await store.initialize();
    return store;
  };

  try {
    const storageReport = await runStorageAdapterConformance({ createAdapter });
    assert.equal(storageReport.contract, "StorageAdapter");
    assert.equal(storageReport.checks.length, 7);
    assert.ok(storageReport.checks.every((check) => check.passed));

    const metadataReport = await runMetadataStoreConformance({ createStore });
    assert.equal(metadataReport.contract, "MetadataStore");
    assert.equal(metadataReport.checks.length, 6);
    assert.ok(metadataReport.checks.every((check) => check.passed));

    const codecAdapter = await createAdapter();
    const persisted = await codecAdapter.insert({
      id: "lossless",
      type: "conformance.codec",
      schemaVersion: 1,
      version: 0,
      values: {
        date: new Date("2026-09-27T18:00:00.000Z"),
        bigint: 9007199254740993n,
        missing: undefined,
        nan: Number.NaN,
        positiveInfinity: Infinity,
        negativeInfinity: -Infinity,
        negativeZero: -0,
      },
      relationships: {},
    });
    const loaded = await codecAdapter.get(persisted);
    assert.ok(loaded);
    assert.ok(loaded.values.date instanceof Date);
    assert.equal(loaded.values.date.toISOString(), "2026-09-27T18:00:00.000Z");
    assert.equal(loaded.values.bigint, 9007199254740993n);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.values, "missing"), true);
    assert.equal(loaded.values.missing, undefined);
    assert.equal(Number.isNaN(loaded.values.nan), true);
    assert.equal(loaded.values.positiveInfinity, Infinity);
    assert.equal(loaded.values.negativeInfinity, -Infinity);
    assert.equal(Object.is(loaded.values.negativeZero, -0), true);

    const queryAdapter = await createAdapter();
    await queryAdapter.saveBatch([
      {
        kind: "insert",
        snapshot: {
          id: "a",
          type: "conformance.pushdown",
          schemaVersion: 1,
          version: 0,
          values: { score: 10, state: "open", nullable: null },
          relationships: {},
        },
      },
      {
        kind: "insert",
        snapshot: {
          id: "b",
          type: "conformance.pushdown",
          schemaVersion: 1,
          version: 0,
          values: { score: 20, state: "closed", nullable: undefined },
          relationships: {},
        },
      },
      {
        kind: "insert",
        snapshot: {
          id: "c",
          type: "conformance.pushdown",
          schemaVersion: 1,
          version: 0,
          values: { score: 20, state: "open", nullable: "value" },
          relationships: {},
        },
      },
      {
        kind: "insert",
        snapshot: {
          id: "d",
          type: "conformance.pushdown",
          schemaVersion: 1,
          version: 0,
          values: { score: Number.NaN, state: "pending" },
          relationships: {},
        },
      },
    ]);

    const pagedEquality = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "score", operator: "eq", value: 20 }],
      offset: 1,
      limit: 1,
    });
    assert.deepEqual(pagedEquality.map((item) => item.id), ["c"]);

    const stateIn = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "state", operator: "in", value: ["open", "pending"] }],
    });
    assert.deepEqual(stateIn.map((item) => item.id), ["a", "c", "d"]);

    const nullable = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "nullable", operator: "isNull" }],
    });
    assert.deepEqual(nullable.map((item) => item.id), ["a", "b", "d"]);

    const undefinedEquality = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "nullable", operator: "eq", value: undefined }],
    });
    assert.deepEqual(undefinedEquality.map((item) => item.id), ["b", "d"]);

    const nanEquality = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "score", operator: "eq", value: Number.NaN }],
    });
    assert.deepEqual(nanEquality.map((item) => item.id), ["d"]);

    const residualComparison = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "score", operator: "gte", value: 15 }],
      orderBy: [{ attribute: "score", direction: "asc" }],
      limit: 2,
    });
    assert.deepEqual(residualComparison.map((item) => item.id), ["b", "c"]);

    const residualString = await queryAdapter.query({
      objectType: "conformance.pushdown",
      where: [{ attribute: "state", operator: "contains", value: "pen" }],
    });
    assert.deepEqual(residualString.map((item) => item.id), ["a", "c", "d"]);

    const raceAdapter = await createAdapter();
    const raceBase = await raceAdapter.insert(snapshot("update-race"));
    const raceResults = await Promise.allSettled([
      raceAdapter.update({ ...raceBase, values: { value: "left" } }, raceBase.version),
      raceAdapter.update({ ...raceBase, values: { value: "right" } }, raceBase.version),
    ]);
    const raceFulfilled = raceResults.filter((result) => result.status === "fulfilled");
    const raceRejected = raceResults.filter((result) => result.status === "rejected");
    assert.equal(raceFulfilled.length, 1, "exactly one concurrent update must commit");
    assert.equal(raceRejected.length, 1, "exactly one concurrent update must lose optimistic concurrency");
    assert.equal(raceRejected[0].reason?.name, "ConcurrencyError");
    const raceCurrent = await raceAdapter.get(raceBase);
    assert.ok(raceCurrent);
    assert.equal(raceCurrent.version, 2);
    assert.ok(raceCurrent.values.value === "left" || raceCurrent.values.value === "right");

    const deleteBase = await raceAdapter.insert(snapshot("delete-update-race"));
    const [updateOutcome, deleteOutcome] = await Promise.allSettled([
      raceAdapter.update({ ...deleteBase, values: { value: "updated" } }, deleteBase.version),
      raceAdapter.delete(deleteBase, deleteBase.version),
    ]);
    assert.equal(
      [updateOutcome, deleteOutcome].filter((result) => result.status === "fulfilled").length,
      1,
      "update/delete race must have exactly one winner",
    );
    const rejectedOutcome = [updateOutcome, deleteOutcome].find((result) => result.status === "rejected");
    assert.ok(rejectedOutcome);
    assert.equal(rejectedOutcome.reason?.name, "ConcurrencyError");
    const afterDeleteRace = await raceAdapter.get(deleteBase);
    if (updateOutcome.status === "fulfilled") {
      assert.ok(afterDeleteRace);
      assert.equal(afterDeleteRace.version, 2);
      assert.equal(afterDeleteRace.values.value, "updated");
    } else {
      assert.equal(afterDeleteRace, null);
    }

    const tamperAdapter = await createAdapter();
    const validEmptyEnvelope = JSON.stringify({ format: 1, value: { kind: "object", value: {} } });
    const invalidDateEnvelope = JSON.stringify({
      format: 1,
      value: {
        kind: "object",
        value: { poisoned: { kind: "date", value: "not-a-date" } },
      },
    });
    await pool.execute(
      `INSERT INTO \`${tamperAdapter.tableName}\`
        (object_type, object_id, schema_version, version, values_json, relationships_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["conformance.tamper", "bad-date", 1, 1, invalidDateEnvelope, validEmptyEnvelope],
    );
    await assert.rejects(
      () => tamperAdapter.get({ type: "conformance.tamper", id: "bad-date" }),
      /Invalid MySQL snapshot encoding/,
    );

    const metadataRaceStore = await createStore();
    const metadataBase = await metadataRaceStore.save(metadataRecord("meta.race"));
    const metadataRace = await Promise.allSettled([
      metadataRaceStore.save(
        { ...metadataBase, status: "published", updatedAt: "2026-09-27T20:01:00.000Z" },
        metadataBase.revision,
      ),
      metadataRaceStore.save(
        { ...metadataBase, status: "deprecated", updatedAt: "2026-09-27T20:02:00.000Z" },
        metadataBase.revision,
      ),
    ]);
    assert.equal(metadataRace.filter((result) => result.status === "fulfilled").length, 1);
    const metadataRaceLoser = metadataRace.find((result) => result.status === "rejected");
    assert.ok(metadataRaceLoser);
    assert.equal(metadataRaceLoser.reason?.name, "ConcurrencyError");
    const metadataCurrent = await metadataRaceStore.get("meta.race", 1);
    assert.ok(metadataCurrent);
    assert.equal(metadataCurrent.revision, 2);
    assert.ok(metadataCurrent.status === "published" || metadataCurrent.status === "deprecated");

    const metadataDeleteBase = await metadataRaceStore.save(metadataRecord("meta.delete-race"));
    const [metadataUpdateOutcome, metadataDeleteOutcome] = await Promise.allSettled([
      metadataRaceStore.save(
        { ...metadataDeleteBase, status: "published", updatedAt: "2026-09-27T20:03:00.000Z" },
        metadataDeleteBase.revision,
      ),
      metadataRaceStore.delete(
        metadataDeleteBase.objectTypeId,
        metadataDeleteBase.objectTypeVersion,
        metadataDeleteBase.revision,
      ),
    ]);
    assert.equal(
      [metadataUpdateOutcome, metadataDeleteOutcome].filter((result) => result.status === "fulfilled").length,
      1,
      "metadata update/delete race must have exactly one winner",
    );
    const metadataDeleteLoser = [metadataUpdateOutcome, metadataDeleteOutcome].find(
      (result) => result.status === "rejected",
    );
    assert.ok(metadataDeleteLoser);
    assert.equal(metadataDeleteLoser.reason?.name, "ConcurrencyError");

    const tamperStore = await createStore();
    const tamperRecord = await tamperStore.save(metadataRecord("meta.tamper"));
    await pool.execute(
      `UPDATE \`${tamperStore.tableName}\` SET snapshot_json = ?
       WHERE object_type_id = ? AND object_type_version = ?`,
      [validEmptyEnvelope, tamperRecord.objectTypeId, tamperRecord.objectTypeVersion],
    );
    await assert.rejects(
      () => tamperStore.get(tamperRecord.objectTypeId, tamperRecord.objectTypeVersion),
      /snapshot objectType must be an object record/,
    );
  } finally {
    for (const tableName of tables) {
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.end();
  }
});
