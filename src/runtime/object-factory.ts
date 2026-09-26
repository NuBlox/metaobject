import { BehaviorRegistry } from "../behavior/behavior-registry.js";
import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeDefinition, ResolvedObjectTypeDefinition } from "../metadata/definitions.js";
import type { InferInputValues, InferValues } from "../metadata/inference.js";
import type { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { TypeRegistry } from "../types/type-registry.js";
import { MetaObject } from "./meta-object.js";
import type { ObjectSnapshot } from "./model.js";

export type IdGenerator = () => string;

export class ObjectFactory {
  constructor(
    private readonly objects: ObjectTypeRegistry,
    private readonly types: TypeRegistry,
    private readonly idGenerator: IdGenerator = () => crypto.randomUUID(),
    readonly behaviors: BehaviorRegistry = new BehaviorRegistry(),
  ) {}

  create<const D extends ObjectTypeDefinition>(definition: D, values: InferInputValues<D>): MetaObject<InferValues<D>>;
  create(objectTypeId: string, values?: Record<string, unknown>): MetaObject;
  create(
    definitionOrId: ObjectTypeDefinition | string,
    values: Record<string, unknown> = {},
  ): MetaObject {
    const definition = this.resolveDefinition(definitionOrId);
    this.assertConcrete(definition);
    const object = new MetaObject(this.idGenerator(), definition, this.types, {
      isTypeAssignable: (actual, expected) => this.objects.isA(actual, expected),
      behaviors: this.behaviors,
    });
    this.applyDefaults(object);
    for (const [name, value] of Object.entries(values)) object.set(name, value);
    return object;
  }

  hydrate(snapshot: ObjectSnapshot): MetaObject {
    const definition = this.objects.resolve(snapshot.type);
    this.assertConcrete(definition);
    const object = new MetaObject(snapshot.id, definition, this.types, {
      version: snapshot.version,
      state: "clean",
      isTypeAssignable: (actual, expected) => this.objects.isA(actual, expected),
      behaviors: this.behaviors,
    });
    const values: Record<string, unknown> = {};
    for (const [name, storedValue] of Object.entries(snapshot.values)) {
      const attribute = definition.attributes[name];
      if (!attribute || storedValue === null || storedValue === undefined) {
        values[name] = storedValue;
        continue;
      }
      const type = this.types.get(attribute.type);
      values[name] = attribute.multiple && Array.isArray(storedValue)
        ? storedValue.map((item) => type.deserialize(item))
        : type.deserialize(storedValue);
    }
    object.load(values, snapshot.relationships);
    object.markPersisted(snapshot.version);
    return object;
  }

  private resolveDefinition(definitionOrId: ObjectTypeDefinition | string): ResolvedObjectTypeDefinition {
    if (typeof definitionOrId === "string") return this.objects.resolve(definitionOrId);
    if (!this.objects.has(definitionOrId.id)) {
      throw new MetadataError(
        `Object type '${definitionOrId.id}' must be registered before instances can be created.`,
      );
    }
    return this.objects.resolve(definitionOrId.id);
  }

  private assertConcrete(definition: ResolvedObjectTypeDefinition): void {
    if (definition.abstract) {
      throw new MetadataError(`Cannot instantiate abstract object type '${definition.id}'.`);
    }
  }

  private applyDefaults(object: MetaObject): void {
    for (const [name, attribute] of Object.entries(object.objectType.attributes)) {
      if (attribute.default !== undefined) object.set(name, structuredClone(attribute.default));
    }
  }
}
