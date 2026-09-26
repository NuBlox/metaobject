import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeDefinition, RelationshipDefinition } from "../metadata/definitions.js";
import type { TypeRegistry } from "../types/type-registry.js";
import type {
  ChangeRecord,
  ObjectReference,
  ObjectSnapshot,
  ObjectState,
  RelationshipChangeRecord,
  RelationshipValue,
} from "./model.js";
import { sameObjectIdentity } from "./model.js";

function copyReference(value: ObjectReference): ObjectReference {
  return { id: value.id, type: value.type };
}

function copyRelationship(value: RelationshipValue | undefined): RelationshipValue | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value)
    ? value.map((item) => copyReference(item))
    : copyReference(value as ObjectReference);
}

function relationshipValuesEqual(left: RelationshipValue | undefined, right: RelationshipValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftRefs = Array.isArray(left) ? left : [left];
  const rightRefs = Array.isArray(right) ? right : [right];
  return leftRefs.length === rightRefs.length
    && leftRefs.every((item, index) => sameObjectIdentity(item, rightRefs[index]!));
}

function isToMany(definition: RelationshipDefinition): boolean {
  return definition.cardinality === "one-to-many" || definition.cardinality === "many-to-many";
}

export type TypeAssignability = (actualType: string, expectedType: string) => boolean;

export class MetaObject<TValues extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly objectType: ObjectTypeDefinition;
  #version: number;
  #state: ObjectState;
  #mutationRevision = 0;
  readonly #values = new Map<string, unknown>();
  readonly #relationships = new Map<string, RelationshipValue>();
  readonly #changes = new Map<string, ChangeRecord>();
  readonly #relationshipChanges = new Map<string, RelationshipChangeRecord>();
  readonly #isTypeAssignable: TypeAssignability;

  constructor(
    id: string,
    objectType: ObjectTypeDefinition,
    private readonly types: TypeRegistry,
    options: { version?: number; state?: ObjectState; isTypeAssignable?: TypeAssignability } = {},
  ) {
    this.id = id;
    this.objectType = objectType;
    this.#version = options.version ?? 0;
    this.#state = options.state ?? "new";
    this.#isTypeAssignable = options.isTypeAssignable ?? ((actual, expected) => actual === expected);
  }

  get version(): number { return this.#version; }
  get state(): ObjectState { return this.#state; }
  /** Monotonic in-memory revision incremented whenever stored values/relationships mutate. */
  get mutationRevision(): number { return this.#mutationRevision; }

  get<K extends keyof TValues & string>(attribute: K): TValues[K] | undefined;
  get(attribute: string): unknown;
  get(attribute: string): unknown { return this.#values.get(attribute); }

  set<K extends keyof TValues & string>(attribute: K, value: TValues[K]): this;
  set(attribute: string, value: unknown): this;
  set(attribute: string, value: unknown): this {
    this.assertMutable();
    const definition = this.objectType.attributes[attribute];
    if (!definition) throw new MetadataError(`Unknown attribute '${this.objectType.id}.${attribute}'.`);
    if (definition.readOnly && this.#state !== "new") throw new MetadataError(`Attribute '${attribute}' is read-only.`);
    this.assertValue(definition.type, definition.multiple === true, definition.nullable === true, value, attribute);
    const before = this.#values.get(attribute);
    if (this.valuesEqual(definition.type, definition.multiple === true, before, value)) return this;
    if (!this.#changes.has(attribute)) this.#changes.set(attribute, { before, after: value });
    else this.#changes.set(attribute, { before: this.#changes.get(attribute)?.before, after: value });
    this.#values.set(attribute, value);
    this.markDirty();
    return this;
  }

  unset(attribute: keyof TValues & string): this;
  unset(attribute: string): this;
  unset(attribute: string): this {
    this.assertMutable();
    const definition = this.objectType.attributes[attribute];
    if (!definition) throw new MetadataError(`Unknown attribute '${this.objectType.id}.${attribute}'.`);
    if (!this.#values.has(attribute)) return this;
    const before = this.#values.get(attribute);
    if (!this.#changes.has(attribute)) this.#changes.set(attribute, { before, after: undefined });
    else this.#changes.set(attribute, { before: this.#changes.get(attribute)?.before, after: undefined });
    this.#values.delete(attribute);
    this.markDirty();
    return this;
  }

  has(attribute: string): boolean { return this.#values.has(attribute); }

  /** Replace the complete relationship value. */
  setRelationship(name: string, value: ObjectReference | readonly ObjectReference[]): this {
    this.assertMutable();
    const definition = this.relationshipDefinition(name);
    const many = isToMany(definition);
    const refs = Array.isArray(value) ? value : [value];

    if (!many && refs.length > 1) {
      throw new MetadataError(`Relationship '${name}' accepts at most one target.`);
    }

    if (refs.length === 0) return this.clearRelationship(name);

    const normalized = this.normalizeReferences(name, definition, refs);
    const next: RelationshipValue = many ? normalized : normalized[0]!;
    this.writeRelationship(name, next);
    return this;
  }

  /** Add one target to a to-many relationship. */
  addRelationship(name: string, target: ObjectReference, index?: number): this {
    this.assertMutable();
    const definition = this.relationshipDefinition(name);
    if (!isToMany(definition)) {
      throw new MetadataError(`Relationship '${name}' is not a to-many relationship.`);
    }
    this.assertReference(name, definition, target);

    const current = this.relationshipReferences(name);
    if (current.some((item) => sameObjectIdentity(item, target))) return this;

    const next = current.map(copyReference);
    const copied = copyReference(target);
    if (index === undefined) {
      next.push(copied);
    } else {
      if (!definition.ordered) {
        throw new MetadataError(`Relationship '${name}' is not ordered and does not accept an insertion index.`);
      }
      if (!Number.isSafeInteger(index) || index < 0 || index > next.length) {
        throw new MetadataError(`Relationship '${name}' insertion index '${index}' is out of range.`);
      }
      next.splice(index, 0, copied);
    }
    this.writeRelationship(name, next);
    return this;
  }

  /** Remove a target from a relationship without mutating the target object. */
  removeRelationship(name: string, target?: ObjectReference): this {
    this.assertMutable();
    const definition = this.relationshipDefinition(name);
    const current = this.#relationships.get(name);
    if (current === undefined) return this;

    if (!isToMany(definition)) {
      const currentRef = current as ObjectReference;
      if (target && !sameObjectIdentity(currentRef, target)) return this;
      this.writeRelationship(name, undefined);
      return this;
    }

    if (!target) {
      throw new MetadataError(`Removing from to-many relationship '${name}' requires a target. Use clearRelationship() to remove all targets.`);
    }
    const refs = current as readonly ObjectReference[];
    const next = refs.filter((item) => !sameObjectIdentity(item, target));
    if (next.length === refs.length) return this;
    this.writeRelationship(name, next.length > 0 ? next : undefined);
    return this;
  }

  clearRelationship(name: string): this {
    this.assertMutable();
    this.relationshipDefinition(name);
    if (!this.#relationships.has(name)) return this;
    this.writeRelationship(name, undefined);
    return this;
  }

  getRelationship(name: string): RelationshipValue | undefined {
    return copyRelationship(this.#relationships.get(name));
  }

  relationshipReferences(name: string): readonly ObjectReference[] {
    const value = this.#relationships.get(name);
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) => copyReference(item));
  }

  relationshipCount(name: string): number {
    return this.relationshipReferences(name).length;
  }

  hasRelationship(name: string, target?: ObjectReference): boolean {
    const refs = this.relationshipReferences(name);
    return target === undefined
      ? refs.length > 0
      : refs.some((item) => sameObjectIdentity(item, target));
  }

  /** True when an actual object type can be assigned to this relationship target. */
  acceptsRelationshipTarget(name: string, actualType: string): boolean {
    const definition = this.relationshipDefinition(name);
    return this.#isTypeAssignable(actualType, definition.target);
  }

  changedAttributes(): Readonly<Record<string, ChangeRecord>> {
    return Object.fromEntries(this.#changes);
  }

  changedRelationships(): Readonly<Record<string, RelationshipChangeRecord>> {
    return Object.fromEntries(
      [...this.#relationshipChanges.entries()].map(([name, change]) => [
        name,
        {
          before: copyRelationship(change.before),
          after: copyRelationship(change.after),
        },
      ]),
    );
  }

  values(): Readonly<Record<string, unknown>> { return Object.fromEntries(this.#values); }

  relationships(): Readonly<Record<string, RelationshipValue>> {
    return Object.fromEntries(
      [...this.#relationships.entries()].map(([name, value]) => [name, copyRelationship(value)!]),
    );
  }

  toJSON(): Record<string, unknown> {
    const serialized: Record<string, unknown> = {
      $id: this.id,
      $type: this.objectType.id,
      $schemaVersion: this.objectType.version,
      $version: this.#version,
    };
    for (const [name, value] of this.#values) {
      const definition = this.objectType.attributes[name]!;
      if (value === null || value === undefined) {
        serialized[name] = value;
        continue;
      }
      const type = this.types.get(definition.type);
      serialized[name] = definition.multiple && Array.isArray(value)
        ? value.map((item) => type.serialize(item))
        : type.serialize(value);
    }
    for (const [name, value] of this.#relationships) serialized[name] = copyRelationship(value);
    return serialized;
  }

  snapshot(): ObjectSnapshot {
    return {
      id: this.id,
      type: this.objectType.id,
      schemaVersion: this.objectType.version,
      version: this.#version,
      values: structuredClone(this.values()),
      relationships: structuredClone(this.relationships()),
    };
  }

  markPersisted(version: number): void {
    this.#version = version;
    this.#changes.clear();
    this.#relationshipChanges.clear();
    this.#state = "clean";
  }

  markDeleted(): void { this.#state = "deleted"; }
  markDetached(): void { this.#state = "detached"; }

  load(values: Readonly<Record<string, unknown>>, relationships: Readonly<Record<string, RelationshipValue>>): void {
    this.#values.clear();
    this.#relationships.clear();
    for (const [name, value] of Object.entries(values)) this.#values.set(name, value);
    for (const [name, value] of Object.entries(relationships)) {
      const copied = copyRelationship(value);
      if (copied !== undefined) this.#relationships.set(name, copied);
    }
    this.#changes.clear();
    this.#relationshipChanges.clear();
    this.#mutationRevision += 1;
  }

  private assertMutable(): void {
    if (this.#state === "deleted" || this.#state === "detached") {
      throw new MetadataError(`Cannot mutate object in '${this.#state}' state.`);
    }
  }

  private markDirty(): void {
    this.#mutationRevision += 1;
    if (this.#state === "clean") this.#state = "dirty";
  }

  private relationshipDefinition(name: string): RelationshipDefinition {
    const definition = this.objectType.relationships?.[name];
    if (!definition) throw new MetadataError(`Unknown relationship '${this.objectType.id}.${name}'.`);
    return definition;
  }

  private normalizeReferences(
    name: string,
    definition: RelationshipDefinition,
    refs: readonly ObjectReference[],
  ): ObjectReference[] {
    const normalized: ObjectReference[] = [];
    for (const ref of refs) {
      this.assertReference(name, definition, ref);
      if (!normalized.some((item) => sameObjectIdentity(item, ref))) normalized.push(copyReference(ref));
    }
    return normalized;
  }

  private assertReference(name: string, definition: RelationshipDefinition, ref: ObjectReference): void {
    if (!ref.id || !ref.type) throw new MetadataError(`Relationship '${name}' requires a target id and type.`);
    if (!this.#isTypeAssignable(ref.type, definition.target)) {
      throw new MetadataError(`Relationship '${name}' requires target type assignable to '${definition.target}', received '${ref.type}'.`);
    }
  }

  private writeRelationship(name: string, value: RelationshipValue | undefined): void {
    const before = this.#relationships.get(name);
    if (relationshipValuesEqual(before, value)) return;

    const existingChange = this.#relationshipChanges.get(name);
    const original = existingChange?.before ?? copyRelationship(before);
    const next = copyRelationship(value);

    if (next === undefined) this.#relationships.delete(name);
    else this.#relationships.set(name, next);

    if (relationshipValuesEqual(original, next)) {
      this.#relationshipChanges.delete(name);
    } else {
      this.#relationshipChanges.set(name, {
        before: copyRelationship(original),
        after: copyRelationship(next),
      });
    }
    this.markDirty();
  }

  private assertValue(typeName: string, multiple: boolean, nullable: boolean, value: unknown, attribute: string): void {
    if (value === null) {
      if (!nullable) throw new TypeError(`Attribute '${attribute}' does not allow null.`);
      return;
    }
    const type = this.types.get(typeName);
    if (multiple) {
      if (!Array.isArray(value) || !value.every((item) => type.validate(item))) {
        throw new TypeError(`Attribute '${attribute}' requires an array of '${typeName}' values.`);
      }
      return;
    }
    if (!type.validate(value)) throw new TypeError(`Attribute '${attribute}' requires type '${typeName}'.`);
  }

  private valuesEqual(typeName: string, multiple: boolean, left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === undefined || right === undefined || left === null || right === null) return false;
    const type = this.types.get(typeName);
    if (multiple) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every((value, index) => type.equals ? type.equals(value, right[index]) : Object.is(value, right[index]));
    }
    return type.equals ? type.equals(left, right) : Object.is(left, right);
  }
}
