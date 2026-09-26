import { ConcurrencyError } from "../errors/errors.js";
import type {
  MetadataRecord,
  MetadataRecordFilter,
  MetadataStore,
} from "./metadata-store.js";

const keyOf = (objectTypeId: string, version: number): string => `${objectTypeId}@${version}`;
const clone = <T>(value: T): T => structuredClone(value);

export class MemoryMetadataStore implements MetadataStore {
  readonly #records = new Map<string, MetadataRecord>();

  async get(objectTypeId: string, version: number): Promise<MetadataRecord | null> {
    const record = this.#records.get(keyOf(objectTypeId, version));
    return record ? clone(record) : null;
  }

  async list(filter: MetadataRecordFilter = {}): Promise<readonly MetadataRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.objectTypeId === undefined || record.objectTypeId === filter.objectTypeId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.objectTypeId.localeCompare(right.objectTypeId) || left.objectTypeVersion - right.objectTypeVersion)
      .map(clone);
  }

  async save(record: MetadataRecord, expectedRevision?: number): Promise<MetadataRecord> {
    const key = keyOf(record.objectTypeId, record.objectTypeVersion);
    const current = this.#records.get(key);
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new ConcurrencyError(`Metadata '${key}' does not exist at expected revision ${expectedRevision}.`);
      }
      const inserted = clone({ ...record, revision: 1 });
      this.#records.set(key, inserted);
      return clone(inserted);
    }
    if (expectedRevision === undefined || current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Metadata concurrency conflict for '${key}': expected revision ${expectedRevision ?? "<missing>"}, found ${current.revision}.`,
      );
    }
    const updated = clone({
      ...record,
      revision: current.revision + 1,
      createdAt: current.createdAt,
    });
    this.#records.set(key, updated);
    return clone(updated);
  }

  async delete(objectTypeId: string, version: number, expectedRevision: number): Promise<void> {
    const key = keyOf(objectTypeId, version);
    const current = this.#records.get(key);
    if (!current) return;
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Metadata concurrency conflict for '${key}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    this.#records.delete(key);
  }
}
