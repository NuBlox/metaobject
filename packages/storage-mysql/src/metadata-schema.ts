import { MetadataError } from "@nublox/metaobject";
import {
  MYSQL_IDENTITY_COLLATION,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "./schema.js";

export const MYSQL_METADATA_SCHEMA_VERSION = 3;
export const DEFAULT_MYSQL_METADATA_TABLE = "metaobject_metadata";
export const MYSQL_METADATA_KEY_MAX_LENGTH = 255;
export const MYSQL_METADATA_VERSION_MAX = 0xffff_ffff;
export const MYSQL_METADATA_TIMESTAMP_MAX_LENGTH = 64;
export const MYSQL_METADATA_V2_INDEX = "idx_metaobject_metadata_type_status";

export function validateMetadataTableName(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  return validateSqlIdentifier(tableName);
}

/** Immutable M71-M72 metadata-table baseline used by migration version 1. */
export function createMetadataTableV1Sql(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  const table = quoteSqlIdentifier(validateMetadataTableName(tableName));
  return `CREATE TABLE IF NOT EXISTS ${table} (
    object_type_id VARCHAR(255) NOT NULL,
    object_type_version INT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    snapshot_json LONGTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (object_type_id, object_type_version),
    KEY idx_metaobject_metadata_status (status, object_type_id, object_type_version),
    CHECK (status IN ('draft', 'published', 'deprecated')),
    CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

/** Immutable v1 -> v2 metadata migration. */
export function createMetadataV2MigrationSql(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  const table = quoteSqlIdentifier(validateMetadataTableName(tableName));
  return `ALTER TABLE ${table}
    ADD KEY ${quoteSqlIdentifier(MYSQL_METADATA_V2_INDEX)} (object_type_id, status, object_type_version)`;
}

/** Immutable v2 -> v3 metadata migration: exact JavaScript-compatible object-type identity equality. */
export function createMetadataV3MigrationSql(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  const table = quoteSqlIdentifier(validateMetadataTableName(tableName));
  return `ALTER TABLE ${table}
    MODIFY object_type_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE ${MYSQL_IDENTITY_COLLATION} NOT NULL`;
}

/** Latest metadata-table DDL for diagnostics and provisioning outside the migrator. */
export function createMetadataTableSql(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  const table = quoteSqlIdentifier(validateMetadataTableName(tableName));
  return `CREATE TABLE IF NOT EXISTS ${table} (
    object_type_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE ${MYSQL_IDENTITY_COLLATION} NOT NULL,
    object_type_version INT UNSIGNED NOT NULL,
    status VARCHAR(16) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    snapshot_json LONGTEXT NOT NULL,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL,
    PRIMARY KEY (object_type_id, object_type_version),
    KEY idx_metaobject_metadata_status (status, object_type_id, object_type_version),
    KEY ${quoteSqlIdentifier(MYSQL_METADATA_V2_INDEX)} (object_type_id, status, object_type_version),
    CHECK (status IN ('draft', 'published', 'deprecated')),
    CHECK (JSON_VALID(snapshot_json))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

export function validateMetadataObjectTypeId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetadataError("Metadata objectTypeId must be a non-empty string.");
  }
  if (Array.from(value).length > MYSQL_METADATA_KEY_MAX_LENGTH) {
    throw new MetadataError(
      `Metadata objectTypeId exceeds MySQL storage limit ${MYSQL_METADATA_KEY_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

export function validateMetadataObjectTypeVersion(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > MYSQL_METADATA_VERSION_MAX
  ) {
    throw new MetadataError(
      `Metadata objectTypeVersion must be an integer between 0 and ${MYSQL_METADATA_VERSION_MAX}.`,
    );
  }
  return value as number;
}

export function validateMetadataTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetadataError(`Metadata ${field} must be a non-empty string.`);
  }
  if (Array.from(value).length > MYSQL_METADATA_TIMESTAMP_MAX_LENGTH) {
    throw new MetadataError(
      `Metadata ${field} exceeds MySQL storage limit ${MYSQL_METADATA_TIMESTAMP_MAX_LENGTH} characters.`,
    );
  }
  return value;
}
