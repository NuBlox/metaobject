import type { MetadataModuleDefinition } from "./metadata-module.js";
import type { MetadataModuleManifest } from "./metadata-module-release.js";

export type MetadataModuleStatus = "draft" | "published" | "deprecated";

export interface MetadataModuleRecord {
  readonly moduleId: string;
  readonly moduleVersion: number;
  readonly status: MetadataModuleStatus;
  readonly revision: number;
  readonly definition: MetadataModuleDefinition;
  readonly releasedManifest?: MetadataModuleManifest;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MetadataModuleRecordFilter {
  readonly moduleId?: string;
  readonly status?: MetadataModuleStatus;
}

export interface MetadataModuleStore {
  get(moduleId: string, version: number): Promise<MetadataModuleRecord | null>;
  list(filter?: MetadataModuleRecordFilter): Promise<readonly MetadataModuleRecord[]>;
  save(record: MetadataModuleRecord, expectedRevision?: number): Promise<MetadataModuleRecord>;
  delete(moduleId: string, version: number, expectedRevision: number): Promise<void>;
}

export interface MetadataModuleBundle {
  readonly format: "nublox-metaobject-modules";
  readonly formatVersion: 1;
  readonly records: readonly MetadataModuleRecord[];
}
