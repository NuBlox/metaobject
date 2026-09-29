import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MYSQL_METADATA_TABLE,
  DEFAULT_MYSQL_MIGRATION_TABLE,
  DEFAULT_MYSQL_STORAGE_TABLE,
  DEFAULT_MYSQL_TRANSACTION_RETRIES,
  MYSQL_IDENTIFIER_MAX_LENGTH,
  MYSQL_IDENTITY_COLLATION,
  MYSQL_METADATA_KEY_MAX_LENGTH,
  MYSQL_METADATA_SCHEMA_VERSION,
  MYSQL_METADATA_V2_INDEX,
  MYSQL_OBJECT_KEY_MAX_LENGTH,
  MYSQL_SCHEMA_VERSION_MAX,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MYSQL_STORAGE_V2_INDEX,
  MySqlMetadataStore,
  MySqlStorageAdapter,
  createMetadataTableSql,
  createMetadataTableV1Sql,
  createMetadataV2MigrationSql,
  createMetadataV3MigrationSql,
  createStorageTableSql,
  createStorageTableV1Sql,
  createStorageV2MigrationSql,
  createStorageV3MigrationSql,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "../dist/index.js";
import { decodeRecord, encodeRecord } from "../dist/codec.js";

test("object and metadata schema DDL are deterministic and versioned", () => {
  assert.equal(MYSQL_IDENTITY_COLLATION, "utf8mb4_0900_bin");
  assert.equal(MYSQL_STORAGE_SCHEMA_VERSION, 3);
  assert.equal(DEFAULT_MYSQL_STORAGE_TABLE, "metaobject_objects");
  const objectV1 = createStorageTableV1Sql();
  assert.match(objectV1, /CREATE TABLE IF NOT EXISTS `metaobject_objects`/);
  assert.doesNotMatch(objectV1, new RegExp(MYSQL_STORAGE_V2_INDEX));
  assert.doesNotMatch(objectV1, new RegExp(MYSQL_IDENTITY_COLLATION));
  const objectSql = createStorageTableSql();
  assert.match(objectSql, /PRIMARY KEY \(object_type, object_id\)/);
  assert.match(objectSql, new RegExp(MYSQL_STORAGE_V2_INDEX));
  assert.match(objectSql, new RegExp(`object_type VARCHAR\\(255\\).*${MYSQL_IDENTITY_COLLATION}`));
  assert.match(objectSql, new RegExp(`object_id VARCHAR\\(255\\).*${MYSQL_IDENTITY_COLLATION}`));
  assert.match(createStorageV2MigrationSql(), /ALTER TABLE `metaobject_objects`/);
  const storageV3 = createStorageV3MigrationSql();
  assert.match(storageV3, new RegExp(`MODIFY object_type.*${MYSQL_IDENTITY_COLLATION}`));
  assert.match(storageV3, new RegExp(`MODIFY object_id.*${MYSQL_IDENTITY_COLLATION}`));

  assert.equal(MYSQL_METADATA_SCHEMA_VERSION, 3);
  assert.equal(DEFAULT_MYSQL_METADATA_TABLE, "metaobject_metadata");
  const metadataV1 = createMetadataTableV1Sql();
  assert.match(metadataV1, /CREATE TABLE IF NOT EXISTS `metaobject_metadata`/);
  assert.doesNotMatch(metadataV1, new RegExp(MYSQL_METADATA_V2_INDEX));
  assert.doesNotMatch(metadataV1, new RegExp(MYSQL_IDENTITY_COLLATION));
  const metadataSql = createMetadataTableSql();
  assert.match(metadataSql, /PRIMARY KEY \(object_type_id, object_type_version\)/);
  assert.match(metadataSql, new RegExp(MYSQL_METADATA_V2_INDEX));
  assert.match(metadataSql, new RegExp(`object_type_id VARCHAR\\(255\\).*${MYSQL_IDENTITY_COLLATION}`));
  assert.match(createMetadataV2MigrationSql(), /ALTER TABLE `metaobject_metadata`/);
  assert.match(createMetadataV3MigrationSql(), new RegExp(`MODIFY object_type_id.*${MYSQL_IDENTITY_COLLATION}`));
  assert.equal(DEFAULT_MYSQL_MIGRATION_TABLE, "metaobject_schema_migrations");
});

test("table identifiers are strictly constrained to the MySQL limit", () => {
  assert.equal(validateSqlIdentifier("metaobject_tenant_01"), "metaobject_tenant_01");
  assert.equal(quoteSqlIdentifier("metaobject_tenant_01"), "`metaobject_tenant_01`");
  assert.throws(() => validateSqlIdentifier("metaobject;DROP TABLE x"), /Invalid MySQL identifier/);
  assert.throws(() => validateSqlIdentifier("x".repeat(MYSQL_IDENTIFIER_MAX_LENGTH + 1)), /Invalid MySQL identifier/);
  assert.throws(() => new MySqlStorageAdapter({}, { tableName: "bad-name" }), /Invalid MySQL identifier/);
  assert.throws(() => new MySqlMetadataStore({}, { tableName: "bad-name" }), /Invalid MySQL identifier/);
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

test("object persistence boundaries fail before reaching MySQL", async () => {
  const pool = {
    query() { throw new Error("database should not be reached"); },
    execute() { throw new Error("database should not be reached"); },
    withTransaction() { throw new Error("database should not be reached"); },
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
  await assert.rejects(() => adapter.update(snapshot, Number.MAX_SAFE_INTEGER), /cannot be incremented/);
  await assert.rejects(() => adapter.get({ id: "", type: "example.item" }), /must be a non-empty string/);
});

test("metadata persistence boundaries fail before reaching MySQL", async () => {
  const pool = {
    query() { throw new Error("database should not be reached"); },
    execute() { throw new Error("database should not be reached"); },
    withTransaction() { throw new Error("database should not be reached"); },
  };
  const store = new MySqlMetadataStore(pool);
  const record = {
    objectTypeId: "example.item",
    objectTypeVersion: 1,
    status: "draft",
    revision: 0,
    snapshot: {
      objectType: {
        objectTypeId: "example.item",
        version: 1,
        name: "Example",
        abstract: false,
        sealed: false,
        extensible: false,
      },
      attributes: [],
      attributeConstraints: [],
      relationships: [],
      indexes: [],
      indexAttributes: [],
      rules: [],
      operations: [],
      events: [],
      hooks: [],
    },
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z",
  };

  await assert.rejects(
    () => store.save({ ...record, objectTypeId: "x".repeat(MYSQL_METADATA_KEY_MAX_LENGTH + 1) }),
    /exceeds MySQL storage limit/,
  );
  await assert.rejects(
    () => store.save({ ...record, snapshot: { ...record.snapshot, objectType: { ...record.snapshot.objectType, objectTypeId: "wrong" } } }),
    /does not match record/,
  );
  await assert.rejects(() => store.save({ ...record, status: "invalid" }), /Invalid metadata status/);
  await assert.rejects(() => store.save(record, Number.MAX_SAFE_INTEGER), /cannot be incremented/);
});

test("batch transactions retry transient lock failures by default and remain configurable", async () => {
  const calls = [];
  const connection = {
    async query() { return { rows: [], fields: [], affectedRows: 0, insertId: 0, serverStatus: 0, warningCount: 0 }; },
    async prepare() {
      return {
        async execute() {
          return { rows: [], fields: [], affectedRows: 1, insertId: 0, serverStatus: 0, warningCount: 0 };
        },
        async close() {},
      };
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
