import type { NormalizedMetadataSnapshot } from "./persistence-model.js";

export type MetadataStatus = "draft" | "published" | "deprecated";

export interface MetadataRecord {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly status: MetadataStatus;
  readonly revision: number;
  readonly snapshot: NormalizedMetadataSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MetadataRecordFilter {
  readonly objectTypeId?: string;
  readonly status?: MetadataStatus;
}

export interface MetadataBatchWrite {
  readonly record: MetadataRecord;
  readonly expectedRevision?: number;
}

export interface MetadataStore {
  get(objectTypeId: string, version: number): Promise<MetadataRecord | null>;
  list(filter?: MetadataRecordFilter): Promise<readonly MetadataRecord[]>;
  /**
   * Insert or replace a metadata record. `expectedRevision` is required for an
   * existing record and provides optimistic concurrency semantics.
   */
  save(record: MetadataRecord, expectedRevision?: number): Promise<MetadataRecord>;
  /**
   * Apply all writes atomically. Either every optimistic revision check and write
   * succeeds or the store remains unchanged. Database adapters should implement
   * this with a transaction.
   */
  saveBatch(writes: readonly MetadataBatchWrite[]): Promise<readonly MetadataRecord[]>;
  delete(objectTypeId: string, version: number, expectedRevision: number): Promise<void>;
}

export interface MetadataBundle {
  readonly format: "nublox-metaobject-metadata";
  readonly formatVersion: 1;
  readonly records: readonly MetadataRecord[];
}
