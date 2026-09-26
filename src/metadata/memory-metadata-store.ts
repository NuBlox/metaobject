import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import type {
  MetadataBatchWrite,
  MetadataRecord,
  MetadataRecordFilter,
  MetadataStore,
} from "./metadata-store.js";

const keyOf = (objectTypeId: string, version: number): string => `${objectTypeId}@${version}`;
const clone = <T>(value: T): T => structuredClone(value);

function applySave(
  records: Map<string, MetadataRecord>,
  record: MetadataRecord,
  expectedRevision?: number,
): MetadataRecord {
  const key = keyOf(record.objectTypeId, record.objectTypeVersion);
  const current = records.get(key);
  if (!current) {
    if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(`Metadata '${key}' does not exist at expected revision ${expectedRevision}.`);
    }
    const inserted = clone({ ...record, revision: 1 });
    records.set(key, inserted);
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
  records.set(key, updated);
  return clone(updated);
}

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
    return applySave(this.#records, record, expectedRevision);
  }

  async saveBatch(writes: readonly MetadataBatchWrite[]): Promise<readonly MetadataRecord[]> {
    const seen = new Set<string>();
    const staged = new Map<string, MetadataRecord>(
      [...this.#records.entries()].map(([key, record]) => [key, clone(record)]),
    );
    const saved: MetadataRecord[] = [];

    for (const write of writes) {
      const key = keyOf(write.record.objectTypeId, write.record.objectTypeVersion);
      if (seen.has(key)) throw new MetadataError(`Duplicate metadata batch write '${key}'.`);
      seen.add(key);
      saved.push(applySave(staged, write.record, write.expectedRevision));
    }

    this.#records.clear();
    for (const [key, record] of staged) this.#records.set(key, clone(record));
    return saved.map(clone);
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
