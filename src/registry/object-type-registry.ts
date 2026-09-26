import { MetadataError, ObjectTypeNotFoundError } from "../errors/errors.js";
import type {
  AttributeDefinition,
  ConstraintDefinition,
  ObjectTypeDefinition,
  RelationshipCardinality,
  RelationshipDefinition,
  RelationshipOwnership,
  ResolvedObjectTypeDefinition,
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
  if (relationship.kind === "composition") {
    if (relationship.cardinality !== "one-to-one" && relationship.cardinality !== "one-to-many") {
      throw new MetadataError(
        `${ownerId}.${name}: composition must be 'one-to-one' or 'one-to-many' from owner to part.`,
      );
    }
    if (relationship.ownership !== undefined && relationship.ownership !== "source") {
      throw new MetadataError(`${ownerId}.${name}: composition ownership must be 'source'.`);
    }
    if (relationship.onSourceDelete !== undefined && relationship.onSourceDelete !== "cascade") {
      throw new MetadataError(`${ownerId}.${name}: composition source deletion must cascade.`);
    }
  }
}

function freezeResolved(definition: ResolvedObjectTypeDefinition): ResolvedObjectTypeDefinition {
  Object.freeze(definition.attributes);
  if (definition.relationships) Object.freeze(definition.relationships);
  if (definition.indexes) Object.freeze(definition.indexes);
  Object.freeze(definition.lineage);
  return Object.freeze(definition);
}

export class ObjectTypeRegistry {
  readonly #definitions = new Map<string, ObjectTypeDefinition>();
  readonly #resolved = new Map<string, ResolvedObjectTypeDefinition>();

  constructor(private readonly types: TypeRegistry) {}

  register<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
    if (!definition.id.trim()) throw new MetadataError("Object type id is required.");
    if (!definition.name.trim()) throw new MetadataError("Object type name is required.");
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new MetadataError(`${definition.id}: version must be a positive integer.`);
    }
    if (definition.baseType === definition.id) {
      throw new MetadataError(`${definition.id}: an object type cannot inherit from itself.`);
    }
    if (this.#definitions.has(definition.id)) {
      throw new MetadataError(`Object type '${definition.id}' is already registered.`);
    }
    for (const [name, attribute] of Object.entries(definition.attributes)) {
      validateAttribute(`${definition.id}.${name}`, attribute, this.types);
    }
    for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
      validateRelationshipShape(definition.id, name, relationship);
    }

    const frozen = Object.freeze(definition);
    this.#definitions.set(definition.id, frozen as ObjectTypeDefinition);
    this.#resolved.clear();
    return frozen;
  }

  /** Return the unflattened definition registered for this exact type. */
  get(id: string): ObjectTypeDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw new ObjectTypeNotFoundError(`Unknown object type '${id}'.`);
    return definition;
  }

  /** Return the flattened runtime definition, including inherited metadata. */
  resolve(id: string): ResolvedObjectTypeDefinition {
    return this.resolveInternal(id, []);
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  all(): readonly ObjectTypeDefinition[] {
    return [...this.#definitions.values()];
  }

  allResolved(): readonly ResolvedObjectTypeDefinition[] {
    return this.all().map((definition) => this.resolve(definition.id));
  }

  validateHierarchy(): void {
    for (const definition of this.#definitions.values()) this.resolve(definition.id);
  }

  lineage(id: string): readonly string[] {
    return this.resolve(id).lineage;
  }

  /** True when actualTypeId is expectedTypeId or transitively derives from it. */
  isA(actualTypeId: string, expectedTypeId: string): boolean {
    if (!this.#definitions.has(actualTypeId) || !this.#definitions.has(expectedTypeId)) return false;
    return this.resolve(actualTypeId).lineage.includes(expectedTypeId);
  }

  directSubtypes(id: string): readonly ObjectTypeDefinition[] {
    this.get(id);
    return [...this.#definitions.values()].filter((definition) => definition.baseType === id);
  }

  subtypes(id: string): readonly ObjectTypeDefinition[] {
    this.get(id);
    return [...this.#definitions.values()].filter(
      (definition) => definition.id !== id && this.isA(definition.id, id),
    );
  }

  validateRelationships(): void {
    this.validateHierarchy();
    for (const definition of this.#definitions.values()) {
      for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
        if (!this.#definitions.has(relationship.target)) {
          throw new MetadataError(`${definition.id}.${name}: unknown target object type '${relationship.target}'.`);
        }
        if (!relationship.inverse) continue;

        const target = this.resolve(relationship.target);
        const inverse = target.relationships?.[relationship.inverse];
        if (!inverse) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse '${relationship.target}.${relationship.inverse}' does not exist.`,
          );
        }
        if (!this.isA(definition.id, inverse.target)) {
          throw new MetadataError(
            `${definition.id}.${name}: inverse '${relationship.target}.${relationship.inverse}' targets '${inverse.target}', which is not assignable from '${definition.id}'.`,
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
        if (relationship.kind === "composition" && inverse.kind === "composition") {
          throw new MetadataError(
            `${definition.id}.${name}: both ends of a relationship cannot independently declare composition ownership.`,
          );
        }
        if (
          relationship.onSourceDelete !== undefined
          && inverse.onTargetDelete !== undefined
          && relationship.onSourceDelete !== inverse.onTargetDelete
        ) {
          throw new MetadataError(`${definition.id}.${name}: onSourceDelete must match inverse onTargetDelete.`);
        }
        if (
          relationship.onTargetDelete !== undefined
          && inverse.onSourceDelete !== undefined
          && relationship.onTargetDelete !== inverse.onSourceDelete
        ) {
          throw new MetadataError(`${definition.id}.${name}: onTargetDelete must match inverse onSourceDelete.`);
        }
      }
    }
  }

  private resolveInternal(id: string, stack: readonly string[]): ResolvedObjectTypeDefinition {
    const cached = this.#resolved.get(id);
    if (cached) return cached;

    const definition = this.get(id);
    if (stack.includes(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
      throw new MetadataError(`Inheritance cycle detected: ${cycle}.`);
    }

    let attributes: Record<string, AttributeDefinition> = { ...definition.attributes };
    let relationships: Record<string, RelationshipDefinition> = { ...(definition.relationships ?? {}) };
    let indexes = [...(definition.indexes ?? [])];
    let lineage = [definition.id];

    if (definition.baseType) {
      if (!this.#definitions.has(definition.baseType)) {
        throw new MetadataError(`${definition.id}: unknown base object type '${definition.baseType}'.`);
      }
      const base = this.resolveInternal(definition.baseType, [...stack, id]);
      if (base.sealed) {
        throw new MetadataError(`${definition.id}: cannot inherit from sealed object type '${base.id}'.`);
      }

      for (const name of Object.keys(definition.attributes)) {
        if (name in base.attributes) {
          throw new MetadataError(`${definition.id}: attribute '${name}' shadows inherited attribute '${base.id}.${name}'.`);
        }
      }
      for (const name of Object.keys(definition.relationships ?? {})) {
        if (name in (base.relationships ?? {})) {
          throw new MetadataError(`${definition.id}: relationship '${name}' shadows inherited relationship '${base.id}.${name}'.`);
        }
      }
      const inheritedIndexNames = new Set((base.indexes ?? []).map((index) => index.name));
      for (const index of definition.indexes ?? []) {
        if (inheritedIndexNames.has(index.name)) {
          throw new MetadataError(`${definition.id}: index '${index.name}' shadows an inherited index.`);
        }
      }

      attributes = { ...base.attributes, ...definition.attributes };
      relationships = { ...(base.relationships ?? {}), ...(definition.relationships ?? {}) };
      indexes = [...(base.indexes ?? []), ...(definition.indexes ?? [])];
      lineage = [...base.lineage, definition.id];
    }

    for (const index of indexes) {
      for (const item of index.attributes) {
        if (!(item.attribute in attributes)) {
          throw new MetadataError(
            `${definition.id}: index '${index.name}' references unknown attribute '${item.attribute}'.`,
          );
        }
      }
    }

    const resolved = freezeResolved({
      ...definition,
      attributes,
      relationships,
      indexes,
      lineage,
      declared: definition,
    });
    this.#resolved.set(id, resolved);
    return resolved;
  }
}
