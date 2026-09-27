import { MetadataError } from "@nublox/metaobject";
import { quoteSqlIdentifier, validateSqlIdentifier } from "./schema.js";

export const MYSQL_METADATA_SCHEMA_VERSION = 1;
export const DEFAULT_MYSQL_METADATA_TABLE = "metaobject_metadata";
export const MYSQL_METADATA_KEY_MAX_LENGTH = 255;
export const MYSQL_METADATA_VERSION_MAX = 0xffff_ffff;
export const MYSQL_METADATA_TIMESTAMP_MAX_LENGTH = 64;

export function validateMetadataTableName(
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
): string {
  return validateSqlIdentifier(tableName);
}

export function createMetadataTableSql(
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
