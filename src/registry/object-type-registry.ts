import { MetadataError, ObjectTypeNotFoundError } from "../errors/errors.js";
import type {
  AttributeDefinition,
  ConstraintDefinition,
  ObjectTypeDefinition,
  RelationshipCardinality,
  RelationshipDefinition,
  RelationshipOwnership,
} from "../metadata/definitions.js";
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

function expectedInverseCardinality(cardinality: RelationshipCardinality): RelationshipCardinality {
  switch (cardinality) {
    case "one-to-one": return "one-to-one";
    case "one-to-many": return "many-to-one";
    case "many-to-one": return "one-to-many";
    case "many-to-many": return "many-to-many";
  }
}

function expectedInverseOwnership(ownership: RelationshipOwnership): RelationshipOwnership {
  switch (ownership) {
    case "source": return "target";
    case "target": return "source";
    case "none": return "none";
  }
}

function validateRelationshipShape(ownerId: string, name: string, relationship: RelationshipDefinition): void {
  if (!relationship.target.trim()) {
    throw new MetadataError(`${ownerId}.${name}: relationship target is required.`);
  }
  const many = relationship.cardinality === "one-to-many" || relationship.cardinality === "many-to-many";
  if (relationship.ordered && !many) {
    throw new MetadataError(`${ownerId}.${name}: 'ordered' is only valid for to-many relationships.`);
  }
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
    for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
      validateRelationshipShape(definition.id, name, relationship);
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
        const target = this.#definitions.get(relationship.target);
        if (!target) {
          throw new MetadataError(`${definition.id}.${name}: unknown target object type '${relationship.target}'.`);
        }
        if (!relationship.inverse) continue;

        const inverse = target.relationships?.[relationship.inverse];
        if (!inverse) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse '${relationship.target}.${relationship.inverse}' does not exist.`,
          );
        }
        if (inverse.target !== definition.id) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse '${relationship.target}.${relationship.inverse}' targets '${inverse.target}' instead of '${definition.id}'.`,
          );
        }
        const expectedCardinality = expectedInverseCardinality(relationship.cardinality);
        if (inverse.cardinality !== expectedCardinality) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse cardinality must be '${expectedCardinality}', received '${inverse.cardinality}'.`,
          );
        }
        if (inverse.inverse !== undefined && inverse.inverse !== name) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse '${relationship.target}.${relationship.inverse}' points back to '${inverse.inverse}' instead of '${name}'.`,
          );
        }
        if (relationship.ownership !== undefined && inverse.ownership !== undefined) {
          const expectedOwnership = expectedInverseOwnership(relationship.ownership);
          if (inverse.ownership !== expectedOwnership) {
            throw new MetadataError(
              `${definition.id}.${name}: inverse ownership must be '${expectedOwnership}', received '${inverse.ownership}'.`,
            );
          }
        }
        if (
          relationship.onSourceDelete !== undefined
          && inverse.onTargetDelete !== undefined
          && relationship.onSourceDelete !== inverse.onTargetDelete
        ) {
          throw new MetadataError(
            `${definition.id}.${name}: onSourceDelete must match inverse onTargetDelete.`,
          );
        }
        if (
          relationship.onTargetDelete !== undefined
          && inverse.onSourceDelete !== undefined
          && relationship.onTargetDelete !== inverse.onSourceDelete
        ) {
          throw new MetadataError(
            `${definition.id}.${name}: onTargetDelete must match inverse onSourceDelete.`,
          );
        }
      }
    }
  }
}
