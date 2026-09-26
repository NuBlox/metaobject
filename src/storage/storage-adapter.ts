import type { ObjectIdentity, ObjectSnapshot } from "../runtime/model.js";
import type { ObjectQuery } from "../query/query.js";

export interface StorageAdapter {
  insert(snapshot: ObjectSnapshot): Promise<ObjectSnapshot>;
  update(snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot>;
  delete(identity: ObjectIdentity, expectedVersion: number): Promise<void>;
  get(identity: ObjectIdentity): Promise<ObjectSnapshot | null>;
  query(query: ObjectQuery): Promise<readonly ObjectSnapshot[]>;
}
