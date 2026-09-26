import type { ObjectTypeDefinition } from "../metadata/definitions.js";
import type { InferValues } from "../metadata/inference.js";
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
  ) {}

  create<const D extends ObjectTypeDefinition>(definition: D, values: InferValues<D>): MetaObject<InferValues<D>>;
  create(objectTypeId: string, values?: Record<string, unknown>): MetaObject;
  create(definitionOrId: ObjectTypeDefinition | string, values: Record<string, unknown> = {}): MetaObject {
    const definition = typeof definitionOrId === "string" ? this.objects.get(definitionOrId) : definitionOrId;
    const object = new MetaObject(this.idGenerator(), definition, this.types);
    this.applyDefaults(object);
    for (const [name, value] of Object.entries(values)) object.set(name, value);
    return object;
  }

  hydrate(snapshot: ObjectSnapshot): MetaObject {
    const definition = this.objects.get(snapshot.type);
    const object = new MetaObject(snapshot.id, definition, this.types, {
      version: snapshot.version,
      state: "clean",
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

  private applyDefaults(object: MetaObject): void {
    for (const [name, attribute] of Object.entries(object.objectType.attributes)) {
      if (attribute.default !== undefined) object.set(name, structuredClone(attribute.default));
    }
  }
}
