import { MetadataError, ValidationError } from "../errors/errors.js";
import type { ObjectQuery } from "../query/query.js";
import type { MetaObject } from "../runtime/meta-object.js";
import type { ObjectFactory } from "../runtime/object-factory.js";
import type { ObjectIdentity } from "../runtime/model.js";
import { objectIdentityKey, sameObjectIdentity } from "../runtime/model.js";
import type { Validator } from "../validation/validation.js";
import type { StorageAdapter } from "./storage-adapter.js";

export interface RepositoryOptions {
  /** Reject snapshots containing references to objects absent from storage. Defaults to true. */
  readonly enforceReferentialIntegrity?: boolean;
}

export class MetaObjectRepository {
  readonly #enforceReferentialIntegrity: boolean;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly factory: ObjectFactory,
    private readonly validator: Validator,
    options: RepositoryOptions = {},
  ) {
    this.#enforceReferentialIntegrity = options.enforceReferentialIntegrity ?? true;
  }

  async save<T extends Record<string, unknown>>(object: MetaObject<T>): Promise<MetaObject<T>> {
    this.assertSavable(object);
    if (object.state === "clean") return object;
    if (this.#enforceReferentialIntegrity) await this.assertReferencesExist(object);
    await this.persist(object);
    return object;
  }

  /**
   * Persist a set of objects as one logical batch. References between objects in
   * the same batch are considered valid, allowing new bidirectional/cyclic graphs.
   * Storage adapters may provide stronger transactional guarantees independently.
   */
  async saveAll<const T extends readonly MetaObject[]>(objects: T): Promise<T> {
    const batchKeys = new Set<string>();
    for (const object of objects) {
      this.assertSavable(object);
      const key = objectIdentityKey({ id: object.id, type: object.objectType.id });
      if (batchKeys.has(key)) throw new ValidationError(`Duplicate object '${key}' in save batch.`);
      batchKeys.add(key);
    }

    if (this.#enforceReferentialIntegrity) {
      for (const object of objects) await this.assertReferencesExist(object, batchKeys);
    }
    for (const object of objects) {
      if (object.state !== "clean") await this.persist(object);
    }
    return objects;
  }

  async find(identity: ObjectIdentity): Promise<MetaObject | null> {
    const snapshot = await this.storage.get(identity);
    return snapshot ? this.factory.hydrate(snapshot) : null;
  }

  async query(query: ObjectQuery): Promise<readonly MetaObject[]> {
    const snapshots = await this.storage.query(query);
    return snapshots.map((snapshot) => this.factory.hydrate(snapshot));
  }

  async related(object: MetaObject, relationshipName: string): Promise<readonly MetaObject[]> {
    if (!object.objectType.relationships?.[relationshipName]) {
      throw new MetadataError(`Unknown relationship '${object.objectType.id}.${relationshipName}'.`);
    }
    const result: MetaObject[] = [];
    for (const reference of object.relationshipReferences(relationshipName)) {
      const related = await this.find(reference);
      if (!related) {
        throw new ValidationError(
          `Dangling relationship '${object.objectType.id}.${relationshipName}' references missing object '${reference.type}:${reference.id}'.`,
        );
      }
      result.push(related);
    }
    return result;
  }

  async delete(object: MetaObject): Promise<void> {
    if (object.state === "new") {
      object.markDeleted();
      return;
    }
    await this.storage.delete({ id: object.id, type: object.objectType.id }, object.version);
    object.markDeleted();
  }

  private assertSavable(object: MetaObject): void {
    const validation = this.validator.validate(object);
    if (!validation.valid) {
      const summary = validation.issues.map((item) => `${item.path ?? "$"}: ${item.message}`).join("; ");
      throw new ValidationError(`Object '${object.objectType.id}' is invalid: ${summary}`);
    }
    if (object.state === "deleted" || object.state === "detached") {
      throw new ValidationError(`Cannot save an object in '${object.state}' state.`);
    }
  }

  private async persist(object: MetaObject): Promise<void> {
    const snapshot = object.snapshot();
    const persisted = object.state === "new"
      ? await this.storage.insert(snapshot)
      : await this.storage.update(snapshot, object.version);
    object.markPersisted(persisted.version);
  }

  private async assertReferencesExist(object: MetaObject, batchKeys: ReadonlySet<string> = new Set()): Promise<void> {
    const self = { id: object.id, type: object.objectType.id };
    for (const [name] of Object.entries(object.objectType.relationships ?? {})) {
      for (const reference of object.relationshipReferences(name)) {
        if (sameObjectIdentity(reference, self)) continue;
        if (batchKeys.has(objectIdentityKey(reference))) continue;
        const target = await this.storage.get(reference);
        if (!target) {
          throw new ValidationError(
            `Relationship '${object.objectType.id}.${name}' references missing object '${reference.type}:${reference.id}'.`,
          );
        }
      }
    }
  }
}
