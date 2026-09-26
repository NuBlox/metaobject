import type { ObjectIdentity, ObjectSnapshot } from "../runtime/model.js";
import type { ObjectQuery } from "../query/query.js";

export type StorageBatchWrite =
  | {
      readonly kind: "insert";
      readonly snapshot: ObjectSnapshot;
    }
  | {
      readonly kind: "update";
      readonly snapshot: ObjectSnapshot;
      readonly expectedVersion: number;
    };

export interface StorageAdapter {
  insert(snapshot: ObjectSnapshot): Promise<ObjectSnapshot>;
  update(snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot>;
  /**
   * Persist every insert/update atomically. Either all writes succeed and their
   * resulting snapshots are returned in request order, or storage is unchanged.
   * SQL adapters should implement this with a database transaction.
   */
  saveBatch(writes: readonly StorageBatchWrite[]): Promise<readonly ObjectSnapshot[]>;
  delete(identity: ObjectIdentity, expectedVersion: number): Promise<void>;
  get(identity: ObjectIdentity): Promise<ObjectSnapshot | null>;
  query(query: ObjectQuery): Promise<readonly ObjectSnapshot[]>;
}
