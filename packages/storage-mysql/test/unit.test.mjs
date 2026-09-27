import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MYSQL_STORAGE_TABLE,
  DEFAULT_MYSQL_TRANSACTION_RETRIES,
  MYSQL_OBJECT_KEY_MAX_LENGTH,
  MYSQL_SCHEMA_VERSION_MAX,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MySqlStorageAdapter,
  createStorageTableSql,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "../dist/index.js";
import { decodeRecord, encodeRecord } from "../dist/codec.js";

test("schema constants and DDL are deterministic", () => {
  assert.equal(MYSQL_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_MYSQL_STORAGE_TABLE, "metaobject_objects");
  const sql = createStorageTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `metaobject_objects`/);
  assert.match(sql, /PRIMARY KEY \(object_type, object_id\)/);
  assert.match(sql, /ENGINE=InnoDB/);
});

test("table identifiers are strictly constrained", () => {
  assert.equal(validateSqlIdentifier("metaobject_tenant_01"), "metaobject_tenant_01");
  assert.equal(quoteSqlIdentifier("metaobject_tenant_01"), "`metaobject_tenant_01`");
  assert.throws(() => validateSqlIdentifier("metaobject;DROP TABLE x"), /Invalid MySQL identifier/);
  assert.throws(() => new MySqlStorageAdapter({}, { tableName: "bad-name" }), /Invalid MySQL identifier/);
});

test("codec rejects cycles without invoking accessors", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encodeRecord(cyclic), /cyclic object graphs/);

  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, "danger", {
    enumerable: true,
    get() {
      invoked = true;
      return "boom";
    },
  });
  assert.throws(() => encodeRecord(accessor), /accessor-backed property/);
  assert.equal(invoked, false);
});

test("codec preserves __proto__ as data without prototype pollution", () => {
  const input = {};
  Object.defineProperty(input, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });

  const decoded = decodeRecord(encodeRecord(input));
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded, "__proto__"), true);
  assert.deepEqual(decoded.__proto__, { polluted: true });
});

test("codec rejects malformed canonical values", () => {
  const badDate = JSON.stringify({
    format: 1,
    value: {
      kind: "object",
      value: { date: { kind: "date", value: "not-a-date" } },
    },
  });
  assert.throws(() => decodeRecord(badDate), /Invalid MySQL snapshot encoding/);

  const badBigInt = JSON.stringify({
    format: 1,
    value: {
      kind: "object",
      value: { bigint: { kind: "bigint", value: "+1" } },
    },
  });
  assert.throws(() => decodeRecord(badBigInt), /Invalid MySQL snapshot encoding/);
});

test("persistence boundaries fail before reaching MySQL", async () => {
  const pool = {
    query() {
      throw new Error("database should not be reached");
    },
    execute() {
      throw new Error("database should not be reached");
    },
    withTransaction() {
      throw new Error("database should not be reached");
    },
  };
  const adapter = new MySqlStorageAdapter(pool);
  const snapshot = {
    id: "valid",
    type: "example.item",
    schemaVersion: 1,
    version: 0,
    values: {},
    relationships: {},
  };

  await assert.rejects(
    () => adapter.insert({ ...snapshot, id: "x".repeat(MYSQL_OBJECT_KEY_MAX_LENGTH + 1) }),
    /exceeds MySQL storage limit/,
  );
  await assert.rejects(
    () => adapter.insert({ ...snapshot, schemaVersion: MYSQL_SCHEMA_VERSION_MAX + 1 }),
    /schemaVersion must be an integer/,
  );
  await assert.rejects(
    () => adapter.update(snapshot, Number.MAX_SAFE_INTEGER),
    /cannot be incremented/,
  );
  await assert.rejects(
    () => adapter.get({ id: "", type: "example.item" }),
    /must be a non-empty string/,
  );
});

test("batch transactions retry transient lock failures by default and remain configurable", async () => {
  const calls = [];
  const connection = {
    async execute() {
      return [{ affectedRows: 1 }, undefined];
    },
    async query() {
      return [[], undefined];
    },
  };
  const pool = {
    async withTransaction(work, options) {
      calls.push(options);
      return work(connection, 0);
    },
  };
  const snapshot = {
    id: "a",
    type: "example.item",
    schemaVersion: 1,
    version: 0,
    values: { value: 1 },
    relationships: {},
  };

  const defaults = new MySqlStorageAdapter(pool);
  await defaults.saveBatch([{ kind: "insert", snapshot }]);
  assert.equal(calls[0].maxRetries, DEFAULT_MYSQL_TRANSACTION_RETRIES);

  const configured = new MySqlStorageAdapter(pool, { transaction: { maxRetries: 5, retryDelayMs: 0 } });
  await configured.saveBatch([{ kind: "insert", snapshot: { ...snapshot, id: "b" } }]);
  assert.equal(calls[1].maxRetries, 5);
  assert.equal(calls[1].retryDelayMs, 0);
});
