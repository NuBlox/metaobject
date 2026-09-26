import { ConcurrencyError } from "../errors/errors.js";
import type {
  MetadataModuleRecord,
  MetadataModuleRecordFilter,
  MetadataModuleStore,
} from "./module-store.js";

function keyOf(moduleId: string, version: number): string {
  return `${moduleId}@${version}`;
}

function clone(record: MetadataModuleRecord): MetadataModuleRecord {
  return structuredClone(record);
}

export class MemoryMetadataModuleStore implements MetadataModuleStore {
  readonly #records = new Map<string, MetadataModuleRecord>();

  async get(moduleId: string, version: number): Promise<MetadataModuleRecord | null> {
    const record = this.#records.get(keyOf(moduleId, version));
    return record ? clone(record) : null;
  }

  async list(filter: MetadataModuleRecordFilter = {}): Promise<readonly MetadataModuleRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.moduleId === undefined || record.moduleId === filter.moduleId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId) || left.moduleVersion - right.moduleVersion)
      .map(clone);
  }

  async save(record: MetadataModuleRecord, expectedRevision?: number): Promise<MetadataModuleRecord> {
    const key = keyOf(record.moduleId, record.moduleVersion);
    const current = this.#records.get(key);
    if (current) {
      if (expectedRevision === undefined) {
        throw new ConcurrencyError(`Metadata module '${key}' already exists; expectedRevision is required.`);
      }
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyError(
          `Metadata module concurrency conflict for '${key}': expected revision ${expectedRevision}, found ${current.revision}.`,
        );
      }
    } else if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(
        `Metadata module '${key}' does not exist; expected revision ${expectedRevision} cannot be satisfied.`,
      );
    }

    const stored = clone({ ...record, revision: (current?.revision ?? 0) + 1 });
    this.#records.set(key, stored);
    return clone(stored);
  }

  async delete(moduleId: string, version: number, expectedRevision: number): Promise<void> {
    const key = keyOf(moduleId, version);
    const current = this.#records.get(key);
    if (!current) return;
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Metadata module concurrency conflict for '${key}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    this.#records.delete(key);
  }
}
