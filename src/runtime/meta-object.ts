import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeDefinition } from "../metadata/definitions.js";
import type { TypeRegistry } from "../types/type-registry.js";
import type { ChangeRecord, ObjectReference, ObjectSnapshot, ObjectState } from "./model.js";

function copyReference(value: ObjectReference): ObjectReference {
  return { id: value.id, type: value.type };
}

export class MetaObject<TValues extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly objectType: ObjectTypeDefinition;
  #version: number;
  #state: ObjectState;
  readonly #values = new Map<string, unknown>();
  readonly #relationships = new Map<string, ObjectReference | readonly ObjectReference[]>();
  readonly #changes = new Map<string, ChangeRecord>();

  constructor(
    id: string,
    objectType: ObjectTypeDefinition,
    private readonly types: TypeRegistry,
    options: { version?: number; state?: ObjectState } = {},
  ) {
    this.id = id;
    this.objectType = objectType;
    this.#version = options.version ?? 0;
    this.#state = options.state ?? "new";
  }

  get version(): number { return this.#version; }
  get state(): ObjectState { return this.#state; }

  get<K extends keyof TValues & string>(attribute: K): TValues[K] | undefined;
  get(attribute: string): unknown;
  get(attribute: string): unknown { return this.#values.get(attribute); }

  set<K extends keyof TValues & string>(attribute: K, value: TValues[K]): this;
  set(attribute: string, value: unknown): this;
  set(attribute: string, value: unknown): this {
    if (this.#state === "deleted" || this.#state === "detached") {
      throw new MetadataError(`Cannot mutate object in '${this.#state}' state.`);
    }
    const definition = this.objectType.attributes[attribute];
    if (!definition) throw new MetadataError(`Unknown attribute '${this.objectType.id}.${attribute}'.`);
    if (definition.readOnly && this.#state !== "new") throw new MetadataError(`Attribute '${attribute}' is read-only.`);
    this.assertValue(definition.type, definition.multiple === true, definition.nullable === true, value, attribute);
    const before = this.#values.get(attribute);
    if (this.valuesEqual(definition.type, definition.multiple === true, before, value)) return this;
    if (!this.#changes.has(attribute)) this.#changes.set(attribute, { before, after: value });
    else this.#changes.set(attribute, { before: this.#changes.get(attribute)?.before, after: value });
    this.#values.set(attribute, value);
    if (this.#state === "clean") this.#state = "dirty";
    return this;
  }

  unset(attribute: keyof TValues & string): this;
  unset(attribute: string): this;
  unset(attribute: string): this {
    const definition = this.objectType.attributes[attribute];
    if (!definition) throw new MetadataError(`Unknown attribute '${this.objectType.id}.${attribute}'.`);
    if (!this.#values.has(attribute)) return this;
    const before = this.#values.get(attribute);
    if (!this.#changes.has(attribute)) this.#changes.set(attribute, { before, after: undefined });
    else this.#changes.set(attribute, { before: this.#changes.get(attribute)?.before, after: undefined });
    this.#values.delete(attribute);
    if (this.#state === "clean") this.#state = "dirty";
    return this;
  }

  has(attribute: string): boolean { return this.#values.has(attribute); }

  setRelationship(name: string, value: ObjectReference | readonly ObjectReference[]): this {
    const definition = this.objectType.relationships?.[name];
    if (!definition) throw new MetadataError(`Unknown relationship '${this.objectType.id}.${name}'.`);
    const many = definition.cardinality === "one-to-many" || definition.cardinality === "many-to-many";
    const refs = Array.isArray(value) ? value : [value];
    if (!many && refs.length > 1) throw new MetadataError(`Relationship '${name}' accepts at most one target.`);
    for (const ref of refs) {
      if (ref.type !== definition.target) {
        throw new MetadataError(`Relationship '${name}' requires target type '${definition.target}', received '${ref.type}'.`);
      }
    }
    this.#relationships.set(name, many ? refs.map(copyReference) : copyReference(refs[0]!));
    if (this.#state === "clean") this.#state = "dirty";
    return this;
  }

  getRelationship(name: string): ObjectReference | readonly ObjectReference[] | undefined {
    return this.#relationships.get(name);
  }

  changedAttributes(): Readonly<Record<string, ChangeRecord>> { return Object.fromEntries(this.#changes); }
  values(): Readonly<Record<string, unknown>> { return Object.fromEntries(this.#values); }
  relationships(): Readonly<Record<string, ObjectReference | readonly ObjectReference[]>> { return Object.fromEntries(this.#relationships); }

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
    for (const [name, value] of this.#relationships) serialized[name] = value;
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
    this.#state = "clean";
  }

  markDeleted(): void { this.#state = "deleted"; }
  markDetached(): void { this.#state = "detached"; }

  load(values: Readonly<Record<string, unknown>>, relationships: Readonly<Record<string, ObjectReference | readonly ObjectReference[]>>): void {
    this.#values.clear();
    this.#relationships.clear();
    for (const [name, value] of Object.entries(values)) this.#values.set(name, value);
    for (const [name, value] of Object.entries(relationships)) this.#relationships.set(name, value);
    this.#changes.clear();
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
