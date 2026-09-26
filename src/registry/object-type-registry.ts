import { MetadataError, ObjectTypeNotFoundError } from "../errors/errors.js";
import type { AttributeDefinition, ConstraintDefinition, ObjectTypeDefinition } from "../metadata/definitions.js";
import type { TypeRegistry } from "../types/type-registry.js";

function validateConstraint(attributeName: string, constraint: ConstraintDefinition): void {
  switch (constraint.type) {
    case "minLength":
    case "maxLength":
      if (typeof constraint.value !== "number" || constraint.value < 0) {
        throw new MetadataError(`${attributeName}: '${constraint.type}' requires a non-negative numeric value.`);
      }
      return;
    case "range":
      if (constraint.minimum === undefined && constraint.maximum === undefined) {
        throw new MetadataError(`${attributeName}: 'range' requires minimum and/or maximum.`);
      }
      return;
    case "pattern":
      if (!constraint.pattern) throw new MetadataError(`${attributeName}: 'pattern' requires a pattern.`);
      try {
        new RegExp(constraint.pattern, constraint.flags);
      } catch {
        throw new MetadataError(`${attributeName}: invalid regular expression.`);
      }
      return;
  }
}

function validateAttribute(name: string, attribute: AttributeDefinition, types: TypeRegistry): void {
  if (!types.has(attribute.type)) throw new MetadataError(`${name}: unknown attribute type '${attribute.type}'.`);
  for (const constraint of attribute.constraints ?? []) validateConstraint(name, constraint);
}

export class ObjectTypeRegistry {
  readonly #definitions = new Map<string, ObjectTypeDefinition>();

  constructor(private readonly types: TypeRegistry) {}

  register<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
    if (!definition.id.trim()) throw new MetadataError("Object type id is required.");
    if (!definition.name.trim()) throw new MetadataError("Object type name is required.");
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new MetadataError(`${definition.id}: version must be a positive integer.`);
    }
    if (this.#definitions.has(definition.id)) {
      throw new MetadataError(`Object type '${definition.id}' is already registered.`);
    }
    for (const [name, attribute] of Object.entries(definition.attributes)) {
      validateAttribute(name, attribute, this.types);
    }
    for (const index of definition.indexes ?? []) {
      for (const item of index.attributes) {
        if (!(item.attribute in definition.attributes)) {
          throw new MetadataError(`${definition.id}: index '${index.name}' references unknown attribute '${item.attribute}'.`);
        }
      }
    }
    const frozen = Object.freeze(definition);
    this.#definitions.set(definition.id, frozen as ObjectTypeDefinition);
    return frozen;
  }

  get(id: string): ObjectTypeDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw new ObjectTypeNotFoundError(`Unknown object type '${id}'.`);
    return definition;
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  all(): readonly ObjectTypeDefinition[] {
    return [...this.#definitions.values()];
  }

  validateRelationships(): void {
    for (const definition of this.#definitions.values()) {
      for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
        if (!this.#definitions.has(relationship.target)) {
          throw new MetadataError(`${definition.id}.${name}: unknown target object type '${relationship.target}'.`);
        }
      }
    }
  }
}
