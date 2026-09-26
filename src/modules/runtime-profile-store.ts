import type {
  MetadataModuleSetLockfile,
  MetadataModuleSetRequirement,
} from "./module-set.js";

export interface RuntimeProfileDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly requirements: readonly MetadataModuleSetRequirement[];
}

export type RuntimeProfileStatus = "draft" | "active" | "deprecated";

export interface RuntimeProfileRecord {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: RuntimeProfileStatus;
  readonly revision: number;
  readonly definition: RuntimeProfileDefinition;
  /** Exact module closure locked when this profile version is activated. */
  readonly lockfile?: MetadataModuleSetLockfile;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeProfileRecordFilter {
  readonly profileId?: string;
  readonly status?: RuntimeProfileStatus;
}

export interface RuntimeProfileStore {
  get(profileId: string, version: number): Promise<RuntimeProfileRecord | null>;
  list(filter?: RuntimeProfileRecordFilter): Promise<readonly RuntimeProfileRecord[]>;
  save(record: RuntimeProfileRecord, expectedRevision?: number): Promise<RuntimeProfileRecord>;
  delete(profileId: string, version: number, expectedRevision: number): Promise<void>;
}

export interface RuntimeProfileBundle {
  readonly format: "nublox-metaobject-runtime-profiles";
  readonly formatVersion: 1;
  readonly records: readonly RuntimeProfileRecord[];
}

export function defineRuntimeProfile<const D extends RuntimeProfileDefinition>(definition: D): Readonly<D> {
  return Object.freeze(definition);
}
