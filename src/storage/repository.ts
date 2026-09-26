import { MetadataError, ValidationError } from "../errors/errors.js";
import type { IndexDefinition, ResolvedObjectTypeDefinition } from "../metadata/definitions.js";
import type { ObjectQuery } from "../query/query.js";
import type { BehaviorRegistry } from "../runtime/behavior-registry.js";
import type { MetaObject } from "../runtime/meta-object.js";
import type { ObjectFactory } from "../runtime/object-factory.js";
import type { ObjectIdentity, ObjectSnapshot } from "../runtime/model.js";
import { objectIdentityKey, sameObjectIdentity } from "../runtime/model.js";
import type { Validator } from "../validation/validation.js";
import type { StorageAdapter, StorageBatchWrite } from "./storage-adapter.js";

export interface RepositoryOptions {
  /** Reject snapshots containing references to objects absent from storage. Defaults to true. */
  readonly enforceReferentialIntegrity?: boolean;
  /** Enforce metadata `unique` attributes and unique indexes. Defaults to true. */
  readonly enforceUniqueness?: boolean;
  /** Registry used to execute before/after save/delete hooks. */
  readonly behaviors?: BehaviorRegistry;
}

interface RuntimeUniqueConstraint {
  readonly id: string;
  readonly ownerType: string;
  readonly attributes: readonly string[];
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftEntries = Object.entries(left as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = Object.entries(right as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return leftEntries.length === rightEntries.length
      && leftEntries.every(([name, value], index) => {
        const entry = rightEntries[index];
        return entry !== undefined && entry[0] === name && valuesEqual(value, entry[1]);
      });
  }
  return false;
}

function tupleMatches(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]));
}

function completeTuple(values: readonly unknown[]): boolean {
  return values.every((value) => value !== undefined && value !== null);
}

export class MetaObjectRepository {
  readonly #enforceReferentialIntegrity: boolean;
  readonly #enforceUniqueness: boolean;
  readonly #behaviors: BehaviorRegistry | undefined;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly factory: ObjectFactory,
    private readonly validator: Validator,
    options: RepositoryOptions = {},
  ) {
    this.#enforceReferentialIntegrity = options.enforceReferentialIntegrity ?? true;
    this.#enforceUniqueness = options.enforceUniqueness ?? true;
    this.#behaviors = options.behaviors;
  }

  async save<T extends Record<string, unknown>>(object: MetaObject<T>): Promise<MetaObject<T>> {
    this.assertSavableState(object);
    this.#behaviors?.runObjectHooks(object, "beforeSave");
    this.assertValid(object);
    if (object.state === "clean") return object;

    if (this.#enforceReferentialIntegrity) await this.assertReferencesExist(object);
    if (this.#enforceUniqueness) {
      const selfKey = objectIdentityKey({ id: object.id, type: object.objectType.id });
      await this.assertUnique(object, [object], new Set([selfKey]));
    }

    await this.persist(object);
    this.#behaviors?.runObjectHooks(object, "afterSave");
    return object;
  }

  /**
   * Persist a set of objects atomically. References between objects in the same
   * batch are valid and uniqueness is evaluated against the final batch state.
   */
  async saveAll<const T extends readonly MetaObject[]>(objects: T): Promise<T> {
    const batchKeys = new Set<string>();
    for (const object of objects) {
      this.assertSavableState(object);
      const key = objectIdentityKey({ id: object.id, type: object.objectType.id });
      if (batchKeys.has(key)) throw new ValidationError(`Duplicate object '${key}' in save batch.`);
      batchKeys.add(key);
      this.#behaviors?.runObjectHooks(object, "beforeSave");
    }

    for (const object of objects) this.assertValid(object);

    if (this.#enforceReferentialIntegrity) {
      for (const object of objects) await this.assertReferencesExist(object, batchKeys);
    }
    if (this.#enforceUniqueness) {
      for (const object of objects) await this.assertUnique(object, objects, batchKeys);
    }

    const persistedObjects = objects.filter((object) => object.state !== "clean");
    const writes: StorageBatchWrite[] = persistedObjects.map((object) => {
      const snapshot = object.snapshot();
      return object.state === "new"
        ? { kind: "insert", snapshot }
        : { kind: "update", snapshot, expectedVersion: object.version };
    });
    const persisted = await this.storage.saveBatch(writes);
    persistedObjects.forEach((object, index) => object.markPersisted(persisted[index]!.version));
    for (const object of persistedObjects) this.#behaviors?.runObjectHooks(object, "afterSave");
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
    if (object.state === "deleted" || object.state === "detached") {
      throw new ValidationError(`Cannot delete an object in '${object.state}' state.`);
    }
    this.#behaviors?.runObjectHooks(object, "beforeDelete");
    if (object.state !== "new") {
      await this.storage.delete({ id: object.id, type: object.objectType.id }, object.version);
    }
    object.markDeleted();
    this.#behaviors?.runObjectHooks(object, "afterDelete");
  }

  private assertSavableState(object: MetaObject): void {
    if (object.state === "deleted" || object.state === "detached") {
      throw new ValidationError(`Cannot save an object in '${object.state}' state.`);
    }
  }

  private assertValid(object: MetaObject): void {
    const validation = this.validator.validate(object);
    if (!validation.valid) {
      const summary = validation.issues.map((item) => `${item.path ?? "$"}: ${item.message}`).join("; ");
      throw new ValidationError(`Object '${object.objectType.id}' is invalid: ${summary}`);
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

  private uniqueConstraints(object: MetaObject): readonly RuntimeUniqueConstraint[] {
    const registry = this.factory.objectTypes;
    const resolved = registry.resolve(object.objectType.id);
    const constraints: RuntimeUniqueConstraint[] = [];

    for (const [name, attribute] of Object.entries(resolved.attributes)) {
      if (!attribute.unique) continue;
      const ownerType = this.findAttributeOwner(resolved, name);
      constraints.push({ id: `${ownerType}.${name}`, ownerType, attributes: [name] });
    }

    for (const index of resolved.indexes ?? []) {
      if (!index.unique) continue;
      const ownerType = this.findIndexOwner(resolved, index);
      constraints.push({
        id: `${ownerType}.${index.name}`,
        ownerType,
        attributes: index.attributes.map((item) => item.attribute),
      });
    }
    return constraints;
  }

  private findAttributeOwner(resolved: ResolvedObjectTypeDefinition, attributeName: string): string {
    for (const typeId of resolved.lineage) {
      if (this.factory.objectTypes.get(typeId).attributes[attributeName]?.unique) return typeId;
    }
    return resolved.id;
  }

  private findIndexOwner(resolved: ResolvedObjectTypeDefinition, index: IndexDefinition): string {
    for (const typeId of resolved.lineage) {
      if ((this.factory.objectTypes.get(typeId).indexes ?? []).some((candidate) => candidate.name === index.name)) return typeId;
    }
    return resolved.id;
  }

  private uniqueScopeTypes(ownerType: string): readonly string[] {
    return [ownerType, ...this.factory.objectTypes.subtypes(ownerType).map((definition) => definition.id)];
  }

  private async assertUnique(
    object: MetaObject,
    batch: readonly MetaObject[],
    batchKeys: ReadonlySet<string>,
  ): Promise<void> {
    const registry = this.factory.objectTypes;
    for (const constraint of this.uniqueConstraints(object)) {
      const tuple = constraint.attributes.map((attribute) => object.get(attribute));
      // Missing/null values do not participate, matching common SQL UNIQUE semantics.
      if (!completeTuple(tuple)) continue;

      for (const peer of batch) {
        if (peer === object || !registry.isA(peer.objectType.id, constraint.ownerType)) continue;
        const peerTuple = constraint.attributes.map((attribute) => peer.get(attribute));
        if (completeTuple(peerTuple) && tupleMatches(tuple, peerTuple)) {
          throw this.uniqueViolation(constraint, tuple, `${peer.objectType.id}:${peer.id}`);
        }
      }

      for (const typeId of this.uniqueScopeTypes(constraint.ownerType)) {
        const stored = await this.storage.query({ objectType: typeId });
        for (const snapshot of stored) {
          const identity = objectIdentityKey(snapshot);
          if (batchKeys.has(identity)) continue;
          const storedTuple = constraint.attributes.map((attribute) => snapshot.values[attribute]);
          if (completeTuple(storedTuple) && tupleMatches(tuple, storedTuple)) {
            throw this.uniqueViolation(constraint, tuple, identity);
          }
        }
      }
    }
  }

  private uniqueViolation(
    constraint: RuntimeUniqueConstraint,
    tuple: readonly unknown[],
    conflictIdentity: string,
  ): ValidationError {
    return new ValidationError(
      `Unique constraint '${constraint.id}' is violated by values ${JSON.stringify(tuple)}; conflicts with '${conflictIdentity}'.`,
    );
  }
}
