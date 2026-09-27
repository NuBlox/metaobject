import type mysql from "@nublox/mysql";
import {
  ConcurrencyError,
  MetadataError,
  type MetadataBatchWrite,
  type MetadataRecord,
  type MetadataRecordFilter,
  type MetadataStatus,
  type MetadataStore,
  type NormalizedMetadataSnapshot,
} from "@nublox/metaobject";
import { decodeRecord, encodeRecord } from "./codec.js";
import { DEFAULT_MYSQL_TRANSACTION_RETRIES } from "./mysql-storage-adapter.js";
import {
  DEFAULT_MYSQL_METADATA_TABLE,
  createMetadataTableSql,
  validateMetadataObjectTypeId,
  validateMetadataObjectTypeVersion,
  validateMetadataTableName,
  validateMetadataTimestamp,
} from "./metadata-schema.js";
import { quoteSqlIdentifier } from "./schema.js";

interface SqlExecutor {
  query<T = mysql.QueryResult>(
    sql: string,
    values?: unknown[] | Record<string, unknown>,
  ): Promise<mysql.QueryTuple<T>>;
  execute<T = mysql.QueryResult>(
    sql: string,
    values?: unknown[] | Record<string, unknown>,
  ): Promise<mysql.QueryTuple<T>>;
}

interface MetadataRow extends Record<string, unknown> {
  object_type_id: string;
  object_type_version: number | string;
  status: string;
  revision: number | string;
  snapshot_json: unknown;
  created_at: string;
  updated_at: string;
}

interface MetadataStateRow extends Record<string, unknown> {
  revision: number | string;
  created_at: string;
}

export interface MySqlMetadataStoreOptions {
  readonly tableName?: string;
  /**
   * Options forwarded to @nublox/mysql for metadata write transactions.
   * Transient deadlock/lock-timeout retries default to 2 unless overridden.
   */
  readonly transaction?: mysql.TransactionOptions;
}

const METADATA_STATUSES = new Set<MetadataStatus>(["draft", "published", "deprecated"]);
const SNAPSHOT_COLLECTIONS = [
  "attributes",
  "attributeConstraints",
  "relationships",
  "indexes",
  "indexAttributes",
  "rules",
  "operations",
  "events",
  "hooks",
] as const;

const metadataKey = (objectTypeId: string, version: number): string => `${objectTypeId}@${version}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function mysqlErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function toSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MetadataError(`MySQL returned invalid ${field} '${String(value)}'.`);
  }
  return parsed;
}

function validateMetadataStatus(value: unknown): MetadataStatus {
  if (typeof value !== "string" || !METADATA_STATUSES.has(value as MetadataStatus)) {
    throw new MetadataError(`Invalid metadata status '${String(value)}'.`);
  }
  return value as MetadataStatus;
}

function validateExpectedRevision(value: unknown, incrementing: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MetadataError("Expected metadata revision must be a non-negative safe integer.");
  }
  if (incrementing && (value as number) >= Number.MAX_SAFE_INTEGER) {
    throw new MetadataError(
      "Expected metadata revision cannot be incremented without exceeding JavaScript safe-integer range.",
    );
  }
  return value as number;
}

function validateSnapshotShape(
  snapshot: unknown,
  objectTypeId: string,
  objectTypeVersion: number,
): asserts snapshot is NormalizedMetadataSnapshot {
  if (!isRecord(snapshot)) throw new MetadataError("Metadata snapshot must be an object record.");
  if (!isRecord(snapshot.objectType)) {
    throw new MetadataError("Metadata snapshot objectType must be an object record.");
  }
  if (snapshot.objectType.objectTypeId !== objectTypeId) {
    throw new MetadataError(
      `Metadata snapshot objectTypeId '${String(snapshot.objectType.objectTypeId)}' does not match record '${objectTypeId}'.`,
    );
  }
  if (snapshot.objectType.version !== objectTypeVersion) {
    throw new MetadataError(
      `Metadata snapshot version '${String(snapshot.objectType.version)}' does not match record version ${objectTypeVersion}.`,
    );
  }
  for (const collection of SNAPSHOT_COLLECTIONS) {
    if (!Array.isArray(snapshot[collection])) {
      throw new MetadataError(`Metadata snapshot ${collection} must be an array.`);
    }
  }
}

function validateMetadataRecord(record: MetadataRecord): void {
  const objectTypeId = validateMetadataObjectTypeId(record.objectTypeId);
  const version = validateMetadataObjectTypeVersion(record.objectTypeVersion);
  validateMetadataStatus(record.status);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new MetadataError("Metadata revision must be a non-negative safe integer.");
  }
  validateMetadataTimestamp(record.createdAt, "createdAt");
  validateMetadataTimestamp(record.updatedAt, "updatedAt");
  validateSnapshotShape(record.snapshot, objectTypeId, version);
  // Run the bounded M70 codec before any SQL write so unsupported/cyclic metadata
  // fails before a transaction mutates persistent state.
  encodeRecord(record.snapshot as unknown as Readonly<Record<string, unknown>>);
}

function rowToRecord(row: MetadataRow): MetadataRecord {
  const objectTypeId = validateMetadataObjectTypeId(String(row.object_type_id));
  const objectTypeVersion = validateMetadataObjectTypeVersion(
    toSafeInteger(row.object_type_version, "metadata object type version"),
  );
  const snapshot = decodeRecord(row.snapshot_json);
  validateSnapshotShape(snapshot, objectTypeId, objectTypeVersion);
  return {
    objectTypeId,
    objectTypeVersion,
    status: validateMetadataStatus(row.status),
    revision: toSafeInteger(row.revision, "metadata revision"),
    snapshot,
    createdAt: validateMetadataTimestamp(String(row.created_at), "createdAt"),
    updatedAt: validateMetadataTimestamp(String(row.updated_at), "updatedAt"),
  };
}

export class MySqlMetadataStore implements MetadataStore {
  readonly #pool: mysql.PromisePool;
  readonly #tableName: string;
  readonly #table: string;
  readonly #transactionOptions: mysql.TransactionOptions;

  constructor(pool: mysql.PromisePool, options: MySqlMetadataStoreOptions = {}) {
    this.#pool = pool;
    this.#tableName = validateMetadataTableName(options.tableName ?? DEFAULT_MYSQL_METADATA_TABLE);
    this.#table = quoteSqlIdentifier(this.#tableName);
    const transaction = options.transaction ?? {};
    this.#transactionOptions = {
      ...transaction,
      maxRetries: transaction.maxRetries ?? DEFAULT_MYSQL_TRANSACTION_RETRIES,
    };
  }

  get tableName(): string {
    return this.#tableName;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(createMetadataTableSql(this.#tableName));
  }

  async get(objectTypeId: string, version: number): Promise<MetadataRecord | null> {
    validateMetadataObjectTypeId(objectTypeId);
    validateMetadataObjectTypeVersion(version);
    const [rows] = await this.#pool.query<MetadataRow[]>(
      `SELECT object_type_id, object_type_version, status, revision, snapshot_json, created_at, updated_at
       FROM ${this.#table}
       WHERE object_type_id = ? AND object_type_version = ?`,
      [objectTypeId, version],
    );
    const row = rows[0];
    return row ? structuredClone(rowToRecord(row)) : null;
  }

  async list(filter: MetadataRecordFilter = {}): Promise<readonly MetadataRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.objectTypeId !== undefined) {
      validateMetadataObjectTypeId(filter.objectTypeId);
      clauses.push("object_type_id = ?");
      values.push(filter.objectTypeId);
    }
    if (filter.status !== undefined) {
      validateMetadataStatus(filter.status);
      clauses.push("status = ?");
      values.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await this.#pool.query<MetadataRow[]>(
      `SELECT object_type_id, object_type_version, status, revision, snapshot_json, created_at, updated_at
       FROM ${this.#table}
       ${where}
       ORDER BY object_type_id ASC, object_type_version ASC`,
      values,
    );
    return rows.map((row) => structuredClone(rowToRecord(row)));
  }

  async save(record: MetadataRecord, expectedRevision?: number): Promise<MetadataRecord> {
    validateMetadataRecord(record);
    if (expectedRevision !== undefined) validateExpectedRevision(expectedRevision, true);
    return this.#pool.withTransaction(
      (connection) => this.#saveLocked(connection, record, expectedRevision),
      this.#transactionOptions,
    );
  }

  async saveBatch(writes: readonly MetadataBatchWrite[]): Promise<readonly MetadataRecord[]> {
    const seen = new Set<string>();
    for (const write of writes) {
      validateMetadataRecord(write.record);
      if (write.expectedRevision !== undefined) validateExpectedRevision(write.expectedRevision, true);
      const key = metadataKey(write.record.objectTypeId, write.record.objectTypeVersion);
      if (seen.has(key)) throw new MetadataError(`Duplicate metadata batch write '${key}'.`);
      seen.add(key);
    }
    if (writes.length === 0) return [];

    return this.#pool.withTransaction(async (connection) => {
      const results: MetadataRecord[] = [];
      for (const write of writes) {
        results.push(await this.#saveLocked(connection, write.record, write.expectedRevision));
      }
      return results;
    }, this.#transactionOptions);
  }

  async delete(objectTypeId: string, version: number, expectedRevision: number): Promise<void> {
    validateMetadataObjectTypeId(objectTypeId);
    validateMetadataObjectTypeVersion(version);
    validateExpectedRevision(expectedRevision, false);

    await this.#pool.withTransaction(async (connection) => {
      const current = await this.#getStateForUpdate(connection, objectTypeId, version);
      if (!current) return;
      const actualRevision = toSafeInteger(current.revision, "metadata revision");
      if (actualRevision !== expectedRevision) {
        throw new ConcurrencyError(
          `Metadata concurrency conflict for '${metadataKey(objectTypeId, version)}': expected revision ${expectedRevision}, found ${actualRevision}.`,
        );
      }
      const [result] = await connection.execute<mysql.OkPacket>(
        `DELETE FROM ${this.#table}
         WHERE object_type_id = ? AND object_type_version = ? AND revision = ?`,
        [objectTypeId, version, expectedRevision],
      );
      if ((result.affectedRows ?? 0) !== 1) {
        throw new ConcurrencyError(
          `Metadata '${metadataKey(objectTypeId, version)}' changed while delete was committing.`,
        );
      }
    }, this.#transactionOptions);
  }

  async #saveLocked(
    executor: SqlExecutor,
    record: MetadataRecord,
    expectedRevision?: number,
  ): Promise<MetadataRecord> {
    const key = metadataKey(record.objectTypeId, record.objectTypeVersion);
    const current = await this.#getStateForUpdate(
      executor,
      record.objectTypeId,
      record.objectTypeVersion,
    );

    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new ConcurrencyError(
          `Metadata '${key}' does not exist at expected revision ${expectedRevision}.`,
        );
      }
      const inserted: MetadataRecord = { ...record, revision: 1 };
      try {
        await executor.execute<mysql.OkPacket>(
          `INSERT INTO ${this.#table}
            (object_type_id, object_type_version, status, revision, snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            inserted.objectTypeId,
            inserted.objectTypeVersion,
            inserted.status,
            inserted.revision,
            encodeRecord(inserted.snapshot as unknown as Readonly<Record<string, unknown>>),
            inserted.createdAt,
            inserted.updatedAt,
          ],
        );
      } catch (error) {
        if (mysqlErrorCode(error) === "ER_DUP_ENTRY") {
          throw new ConcurrencyError(`Metadata '${key}' was created concurrently.`);
        }
        throw error;
      }
      return structuredClone(inserted);
    }

    const actualRevision = toSafeInteger(current.revision, "metadata revision");
    if (expectedRevision === undefined || actualRevision !== expectedRevision) {
      throw new ConcurrencyError(
        `Metadata concurrency conflict for '${key}': expected revision ${expectedRevision ?? "<missing>"}, found ${actualRevision}.`,
      );
    }
    validateExpectedRevision(actualRevision, true);

    const updated: MetadataRecord = {
      ...record,
      revision: actualRevision + 1,
      createdAt: validateMetadataTimestamp(String(current.created_at), "createdAt"),
    };
    const [result] = await executor.execute<mysql.OkPacket>(
      `UPDATE ${this.#table}
       SET status = ?, revision = ?, snapshot_json = ?, updated_at = ?
       WHERE object_type_id = ? AND object_type_version = ? AND revision = ?`,
      [
        updated.status,
        updated.revision,
        encodeRecord(updated.snapshot as unknown as Readonly<Record<string, unknown>>),
        updated.updatedAt,
        updated.objectTypeId,
        updated.objectTypeVersion,
        actualRevision,
      ],
    );
    if ((result.affectedRows ?? 0) !== 1) {
      throw new ConcurrencyError(`Metadata '${key}' changed while update was committing.`);
    }
    return structuredClone(updated);
  }

  async #getStateForUpdate(
    executor: SqlExecutor,
    objectTypeId: string,
    version: number,
  ): Promise<MetadataStateRow | null> {
    const [rows] = await executor.query<MetadataStateRow[]>(
      `SELECT revision, created_at
       FROM ${this.#table}
       WHERE object_type_id = ? AND object_type_version = ?
       FOR UPDATE`,
      [objectTypeId, version],
    );
    return rows[0] ?? null;
  }
}
