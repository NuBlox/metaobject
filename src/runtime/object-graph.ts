import { MetadataError } from "../errors/errors.js";
import type { RelationshipDefinition, ReferentialAction } from "../metadata/definitions.js";
import type { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { MetaObject } from "./meta-object.js";
import type { ObjectIdentity, ObjectReference } from "./model.js";
import { objectIdentityKey, sameObjectIdentity } from "./model.js";

function toReference(object: MetaObject): ObjectReference {
  return { id: object.id, type: object.objectType.id };
}

function isToMany(definition: RelationshipDefinition): boolean {
  return definition.cardinality === "one-to-many" || definition.cardinality === "many-to-many";
}

/**
 * In-memory graph coordinator for loaded MetaObjects.
 *
 * MetaObject owns relationship values; ObjectGraph coordinates cross-object
 * invariants such as inverse synchronization and referential delete actions.
 */
export class ObjectGraph {
  readonly #objects = new Map<string, MetaObject>();

  constructor(private readonly objectTypes: ObjectTypeRegistry) {}

  attach<T extends MetaObject>(object: T): T {
    const key = objectIdentityKey({ id: object.id, type: object.objectType.id });
    const existing = this.#objects.get(key);
    if (existing && existing !== object) {
      throw new MetadataError(`A different object with identity '${key}' is already attached to this graph.`);
    }
    this.#objects.set(key, object);
    return object;
  }

  attachAll(objects: readonly MetaObject[]): void {
    for (const object of objects) this.attach(object);
  }

  untrack(object: MetaObject): void {
    this.#objects.delete(objectIdentityKey({ id: object.id, type: object.objectType.id }));
  }

  get(identity: ObjectIdentity): MetaObject | undefined {
    return this.#objects.get(objectIdentityKey(identity));
  }

  require(identity: ObjectIdentity): MetaObject {
    const object = this.get(identity);
    if (!object) throw new MetadataError(`Object '${objectIdentityKey(identity)}' is not attached to this graph.`);
    return object;
  }

  all(): readonly MetaObject[] {
    return [...this.#objects.values()];
  }

  connect(source: MetaObject, relationshipName: string, target: MetaObject, index?: number): void {
    this.attach(source);
    this.attach(target);

    const definition = this.relationshipDefinition(source, relationshipName);
    if (target.objectType.id !== definition.target) {
      throw new MetadataError(
        `Relationship '${source.objectType.id}.${relationshipName}' requires target type '${definition.target}', received '${target.objectType.id}'.`,
      );
    }

    const sourceRef = toReference(source);
    const targetRef = toReference(target);

    if (!isToMany(definition)) {
      const existing = source.relationshipReferences(relationshipName)[0];
      if (existing && !sameObjectIdentity(existing, targetRef)) {
        this.disconnect(source, relationshipName, existing);
      }
    }

    if (definition.inverse) {
      const inverse = this.inverseDefinition(source, relationshipName, definition);
      if (!isToMany(inverse)) {
        const existingInverse = target.relationshipReferences(definition.inverse)[0];
        if (existingInverse && !sameObjectIdentity(existingInverse, sourceRef)) {
          throw new MetadataError(
            `Connecting '${source.objectType.id}.${relationshipName}' would violate inverse cardinality on '${target.objectType.id}.${definition.inverse}'.`,
          );
        }
      }
    }

    this.addOneSide(source, relationshipName, definition, targetRef, index);

    if (definition.inverse) {
      const inverse = this.inverseDefinition(source, relationshipName, definition);
      this.addOneSide(target, definition.inverse, inverse, sourceRef);
    }
  }

  disconnect(source: MetaObject, relationshipName: string, target?: MetaObject | ObjectReference): void {
    this.attach(source);
    const definition = this.relationshipDefinition(source, relationshipName);
    const current = source.relationshipReferences(relationshipName);
    const targets = target === undefined
      ? current
      : current.filter((item) => sameObjectIdentity(item, this.asReference(target)));

    for (const targetRef of targets) {
      this.removeOneSide(source, relationshipName, definition, targetRef);
      if (!definition.inverse) continue;
      const targetObject = this.get(targetRef);
      if (!targetObject) continue;
      const inverse = this.inverseDefinition(source, relationshipName, definition);
      this.removeOneSide(targetObject, definition.inverse, inverse, toReference(source));
    }
  }

  related(source: MetaObject, relationshipName: string): readonly MetaObject[] {
    this.relationshipDefinition(source, relationshipName);
    return source.relationshipReferences(relationshipName).map((reference) => this.require(reference));
  }

  /**
   * Apply relationship delete policies and mark the object deleted.
   * This mutates only the in-memory graph. Persistence remains the repository's job.
   */
  delete(object: MetaObject): void {
    this.attach(object);
    this.deleteInternal(object, new Set<string>());
  }

  private deleteInternal(object: MetaObject, visited: Set<string>): void {
    const key = objectIdentityKey({ id: object.id, type: object.objectType.id });
    if (visited.has(key) || object.state === "deleted") return;
    visited.add(key);

    // First reject direct restrictions before making local mutations.
    this.assertDeletionNotRestricted(object);

    // Apply incoming policies: another object references the object being deleted.
    for (const source of [...this.#objects.values()]) {
      if (source === object || source.state === "deleted") continue;
      for (const [name, definition] of Object.entries(source.objectType.relationships ?? {})) {
        const targetRef = toReference(object);
        if (!source.hasRelationship(name, targetRef)) continue;
        const action = definition.onTargetDelete ?? "detach";
        this.applyIncomingDeleteAction(source, name, object, action, visited);
      }
    }

    // Apply outgoing policies from the object being deleted.
    for (const [name, definition] of Object.entries(object.objectType.relationships ?? {})) {
      const refs = object.relationshipReferences(name);
      if (refs.length === 0) continue;
      const action = definition.onSourceDelete ?? "detach";
      if (action === "cascade") {
        for (const reference of refs) {
          const target = this.get(reference);
          if (target) this.deleteInternal(target, visited);
        }
      }
      // Both cascade and detach remove graph edges from the object being deleted.
      this.disconnect(object, name);
    }

    object.markDeleted();
  }

  private assertDeletionNotRestricted(object: MetaObject): void {
    for (const [name, definition] of Object.entries(object.objectType.relationships ?? {})) {
      if ((definition.onSourceDelete ?? "detach") === "restrict" && object.relationshipCount(name) > 0) {
        throw new MetadataError(
          `Cannot delete '${objectIdentityKey(toReference(object))}': relationship '${name}' restricts source deletion.`,
        );
      }
    }

    const targetRef = toReference(object);
    for (const source of this.#objects.values()) {
      if (source === object || source.state === "deleted") continue;
      for (const [name, definition] of Object.entries(source.objectType.relationships ?? {})) {
        if ((definition.onTargetDelete ?? "detach") !== "restrict") continue;
        if (source.hasRelationship(name, targetRef)) {
          throw new MetadataError(
            `Cannot delete '${objectIdentityKey(targetRef)}': '${source.objectType.id}.${name}' restricts target deletion.`,
          );
        }
      }
    }
  }

  private applyIncomingDeleteAction(
    source: MetaObject,
    relationshipName: string,
    target: MetaObject,
    action: ReferentialAction,
    visited: Set<string>,
  ): void {
    if (action === "restrict") return; // already rejected in preflight
    if (action === "cascade") {
      this.deleteInternal(source, visited);
      return;
    }
    this.disconnect(source, relationshipName, target);
  }

  private addOneSide(
    object: MetaObject,
    name: string,
    definition: RelationshipDefinition,
    target: ObjectReference,
    index?: number,
  ): void {
    if (isToMany(definition)) object.addRelationship(name, target, index);
    else object.setRelationship(name, target);
  }

  private removeOneSide(
    object: MetaObject,
    name: string,
    definition: RelationshipDefinition,
    target: ObjectReference,
  ): void {
    if (isToMany(definition)) object.removeRelationship(name, target);
    else object.removeRelationship(name, target);
  }

  private relationshipDefinition(object: MetaObject, name: string): RelationshipDefinition {
    const definition = object.objectType.relationships?.[name];
    if (!definition) throw new MetadataError(`Unknown relationship '${object.objectType.id}.${name}'.`);
    return definition;
  }

  private inverseDefinition(
    source: MetaObject,
    relationshipName: string,
    definition: RelationshipDefinition,
  ): RelationshipDefinition {
    if (!definition.inverse) {
      throw new MetadataError(`Relationship '${source.objectType.id}.${relationshipName}' has no inverse.`);
    }
    const targetType = this.objectTypes.get(definition.target);
    const inverse = targetType.relationships?.[definition.inverse];
    if (!inverse) {
      throw new MetadataError(
        `Relationship '${source.objectType.id}.${relationshipName}' references missing inverse '${definition.target}.${definition.inverse}'.`,
      );
    }
    return inverse;
  }

  private asReference(value: MetaObject | ObjectReference): ObjectReference {
    return value instanceof Object
      && "objectType" in value
      && "id" in value
      ? toReference(value as MetaObject)
      : { id: (value as ObjectReference).id, type: (value as ObjectReference).type };
  }
}
