import type {
  AttributeDefinition,
  ConstraintDefinition,
  HookPhase,
  ObjectRuleDefinition,
  ObjectTypeDefinition,
  ReferentialAction,
  RelationshipCardinality,
  RelationshipKind,
  RelationshipOwnership,
} from "./definitions.js";

export interface ObjectTypeRow {
  readonly objectTypeId: string;
  readonly version: number;
  readonly name: string;
  readonly namespace?: string;
  readonly baseType?: string;
  readonly abstract: boolean;
  readonly sealed: boolean;
  readonly extensible: boolean;
}

export interface AttributeRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly name: string;
  readonly ordinal: number;
  readonly type: string;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly multiple: boolean;
  readonly readOnly: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
  readonly computedResolver?: string;
  readonly computedDependencies?: readonly string[];
  readonly computedCache?: boolean;
}

export interface AttributeConstraintRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly attributeName: string;
  readonly ordinal: number;
  readonly type: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number;
  readonly pattern?: string;
  readonly flags?: string;
  readonly message?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface RelationshipRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly name: string;
  readonly ordinal: number;
  readonly target: string;
  readonly cardinality: RelationshipCardinality;
  readonly required: boolean;
  readonly inverse?: string;
  readonly ownership?: RelationshipOwnership;
  readonly kind?: RelationshipKind;
  readonly ordered: boolean;
  readonly onSourceDelete?: ReferentialAction;
  readonly onTargetDelete?: ReferentialAction;
}

export interface IndexRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly name: string;
  readonly ordinal: number;
  readonly unique: boolean;
}

export interface IndexAttributeRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly indexName: string;
  readonly attribute: string;
  readonly ordinal: number;
  readonly direction?: "asc" | "desc";
}

export interface ObjectRuleRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly id: string;
  readonly ordinal: number;
  readonly type: string;
  readonly message?: string;
  readonly severity?: "error" | "warning" | "info";
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface OperationRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly name: string;
  readonly ordinal: number;
  readonly handler: string;
  readonly description?: string;
}

export interface EventRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly name: string;
  readonly ordinal: number;
  readonly description?: string;
}

export interface HookRow {
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
  readonly id: string;
  readonly ordinal: number;
  readonly phase: HookPhase;
  readonly handler: string;
}

/**
 * Fully normalized persistence representation of one object-type version.
 * A SQL adapter can map each collection directly to a table while document
 * adapters may persist the snapshot atomically.
 */
export interface NormalizedMetadataSnapshot {
  readonly objectType: ObjectTypeRow;
  readonly attributes: readonly AttributeRow[];
  readonly attributeConstraints: readonly AttributeConstraintRow[];
  readonly relationships: readonly RelationshipRow[];
  readonly indexes: readonly IndexRow[];
  readonly indexAttributes: readonly IndexAttributeRow[];
  readonly rules: readonly ObjectRuleRow[];
  readonly operations: readonly OperationRow[];
  readonly events: readonly EventRow[];
  readonly hooks: readonly HookRow[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeConstraint(
  objectTypeId: string,
  objectTypeVersion: number,
  attributeName: string,
  constraint: ConstraintDefinition,
  ordinal: number,
): AttributeConstraintRow {
  return {
    objectTypeId,
    objectTypeVersion,
    attributeName,
    ordinal,
    type: constraint.type,
    ...(constraint.minimum !== undefined ? { minimum: constraint.minimum } : {}),
    ...(constraint.maximum !== undefined ? { maximum: constraint.maximum } : {}),
    ...(constraint.value !== undefined ? { value: constraint.value } : {}),
    ...(constraint.pattern !== undefined ? { pattern: constraint.pattern } : {}),
    ...(constraint.flags !== undefined ? { flags: constraint.flags } : {}),
    ...(constraint.message !== undefined ? { message: constraint.message } : {}),
    ...(constraint.parameters !== undefined ? { parameters: clone(constraint.parameters) } : {}),
  };
}

export function normalizeObjectType(definition: ObjectTypeDefinition): NormalizedMetadataSnapshot {
  const objectTypeId = definition.id;
  const objectTypeVersion = definition.version;
  const attributes: AttributeRow[] = [];
  const attributeConstraints: AttributeConstraintRow[] = [];

  Object.entries(definition.attributes).forEach(([name, attribute], ordinal) => {
    attributes.push({
      objectTypeId,
      objectTypeVersion,
      name,
      ordinal,
      type: attribute.type,
      required: attribute.required ?? false,
      nullable: attribute.nullable ?? false,
      multiple: attribute.multiple ?? false,
      readOnly: attribute.readOnly ?? false,
      unique: attribute.unique ?? false,
      hasDefault: attribute.default !== undefined,
      ...(attribute.default !== undefined ? { defaultValue: clone(attribute.default) } : {}),
      ...(attribute.computed ? {
        computedResolver: attribute.computed.resolver,
        ...(attribute.computed.dependencies !== undefined ? { computedDependencies: [...attribute.computed.dependencies] } : {}),
        ...(attribute.computed.cache !== undefined ? { computedCache: attribute.computed.cache } : {}),
      } : {}),
    });
    (attribute.constraints ?? []).forEach((constraint, constraintOrdinal) => {
      attributeConstraints.push(
        normalizeConstraint(objectTypeId, objectTypeVersion, name, constraint, constraintOrdinal),
      );
    });
  });

  const relationships: RelationshipRow[] = Object.entries(definition.relationships ?? {}).map(
    ([name, relationship], ordinal) => ({
      objectTypeId,
      objectTypeVersion,
      name,
      ordinal,
      target: relationship.target,
      cardinality: relationship.cardinality,
      required: relationship.required ?? false,
      ordered: relationship.ordered ?? false,
      ...(relationship.inverse !== undefined ? { inverse: relationship.inverse } : {}),
      ...(relationship.ownership !== undefined ? { ownership: relationship.ownership } : {}),
      ...(relationship.kind !== undefined ? { kind: relationship.kind } : {}),
      ...(relationship.onSourceDelete !== undefined ? { onSourceDelete: relationship.onSourceDelete } : {}),
      ...(relationship.onTargetDelete !== undefined ? { onTargetDelete: relationship.onTargetDelete } : {}),
    }),
  );

  const indexes: IndexRow[] = [];
  const indexAttributes: IndexAttributeRow[] = [];
  (definition.indexes ?? []).forEach((index, ordinal) => {
    indexes.push({ objectTypeId, objectTypeVersion, name: index.name, ordinal, unique: index.unique ?? false });
    index.attributes.forEach((item, itemOrdinal) => {
      indexAttributes.push({
        objectTypeId,
        objectTypeVersion,
        indexName: index.name,
        attribute: item.attribute,
        ordinal: itemOrdinal,
        ...(item.direction !== undefined ? { direction: item.direction } : {}),
      });
    });
  });

  const rules: ObjectRuleRow[] = (definition.rules ?? []).map((rule, ordinal) => ({
    objectTypeId,
    objectTypeVersion,
    id: rule.id,
    ordinal,
    type: rule.type,
    ...(rule.message !== undefined ? { message: rule.message } : {}),
    ...(rule.severity !== undefined ? { severity: rule.severity } : {}),
    ...(rule.parameters !== undefined ? { parameters: clone(rule.parameters) } : {}),
  }));

  const operations: OperationRow[] = Object.entries(definition.operations ?? {}).map(
    ([name, operation], ordinal) => ({
      objectTypeId,
      objectTypeVersion,
      name,
      ordinal,
      handler: operation.handler,
      ...(operation.description !== undefined ? { description: operation.description } : {}),
    }),
  );

  const events: EventRow[] = Object.entries(definition.events ?? {}).map(([name, event], ordinal) => ({
    objectTypeId,
    objectTypeVersion,
    name,
    ordinal,
    ...(event.description !== undefined ? { description: event.description } : {}),
  }));

  const hooks: HookRow[] = (definition.hooks ?? []).map((hook, ordinal) => ({
    objectTypeId,
    objectTypeVersion,
    id: hook.id,
    ordinal,
    phase: hook.phase,
    handler: hook.handler,
  }));

  return {
    objectType: {
      objectTypeId,
      version: objectTypeVersion,
      name: definition.name,
      abstract: definition.abstract ?? false,
      sealed: definition.sealed ?? false,
      extensible: definition.extensible ?? false,
      ...(definition.namespace !== undefined ? { namespace: definition.namespace } : {}),
      ...(definition.baseType !== undefined ? { baseType: definition.baseType } : {}),
    },
    attributes,
    attributeConstraints,
    relationships,
    indexes,
    indexAttributes,
    rules,
    operations,
    events,
    hooks,
  };
}

function denormalizeConstraint(row: AttributeConstraintRow): ConstraintDefinition {
  return {
    type: row.type,
    ...(row.minimum !== undefined ? { minimum: row.minimum } : {}),
    ...(row.maximum !== undefined ? { maximum: row.maximum } : {}),
    ...(row.value !== undefined ? { value: row.value } : {}),
    ...(row.pattern !== undefined ? { pattern: row.pattern } : {}),
    ...(row.flags !== undefined ? { flags: row.flags } : {}),
    ...(row.message !== undefined ? { message: row.message } : {}),
    ...(row.parameters !== undefined ? { parameters: clone(row.parameters) } : {}),
  };
}

export function denormalizeObjectType(snapshot: NormalizedMetadataSnapshot): ObjectTypeDefinition {
  const attributes: Record<string, AttributeDefinition> = {};
  for (const row of [...snapshot.attributes].sort((left, right) => left.ordinal - right.ordinal)) {
    const constraints = snapshot.attributeConstraints
      .filter((constraint) => constraint.attributeName === row.name)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(denormalizeConstraint);
    attributes[row.name] = {
      type: row.type,
      ...(row.required ? { required: true } : {}),
      ...(row.nullable ? { nullable: true } : {}),
      ...(row.multiple ? { multiple: true } : {}),
      ...(row.readOnly ? { readOnly: true } : {}),
      ...(row.unique ? { unique: true } : {}),
      ...(row.hasDefault ? { default: clone(row.defaultValue) } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      ...(row.computedResolver !== undefined ? {
        computed: {
          resolver: row.computedResolver,
          ...(row.computedDependencies !== undefined ? { dependencies: [...row.computedDependencies] } : {}),
          ...(row.computedCache !== undefined ? { cache: row.computedCache } : {}),
        },
      } : {}),
    };
  }

  const relationships = Object.fromEntries(
    [...snapshot.relationships]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => [row.name, {
        target: row.target,
        cardinality: row.cardinality,
        ...(row.required ? { required: true } : {}),
        ...(row.inverse !== undefined ? { inverse: row.inverse } : {}),
        ...(row.ownership !== undefined ? { ownership: row.ownership } : {}),
        ...(row.kind !== undefined ? { kind: row.kind } : {}),
        ...(row.ordered ? { ordered: true } : {}),
        ...(row.onSourceDelete !== undefined ? { onSourceDelete: row.onSourceDelete } : {}),
        ...(row.onTargetDelete !== undefined ? { onTargetDelete: row.onTargetDelete } : {}),
      }]),
  );

  const indexes = [...snapshot.indexes]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => ({
      name: row.name,
      ...(row.unique ? { unique: true } : {}),
      attributes: snapshot.indexAttributes
        .filter((item) => item.indexName === row.name)
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((item) => ({
          attribute: item.attribute,
          ...(item.direction !== undefined ? { direction: item.direction } : {}),
        })),
    }));

  const rules: ObjectRuleDefinition[] = [...snapshot.rules]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => ({
      id: row.id,
      type: row.type,
      ...(row.message !== undefined ? { message: row.message } : {}),
      ...(row.severity !== undefined ? { severity: row.severity } : {}),
      ...(row.parameters !== undefined ? { parameters: clone(row.parameters) } : {}),
    }));

  const operations = Object.fromEntries(
    [...snapshot.operations]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => [row.name, {
        handler: row.handler,
        ...(row.description !== undefined ? { description: row.description } : {}),
      }]),
  );
  const events = Object.fromEntries(
    [...snapshot.events]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => [row.name, {
        ...(row.description !== undefined ? { description: row.description } : {}),
      }]),
  );
  const hooks = [...snapshot.hooks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => ({ id: row.id, phase: row.phase, handler: row.handler }));

  const row = snapshot.objectType;
  return {
    id: row.objectTypeId,
    name: row.name,
    version: row.version,
    attributes,
    ...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
    ...(row.baseType !== undefined ? { baseType: row.baseType } : {}),
    ...(row.abstract ? { abstract: true } : {}),
    ...(row.sealed ? { sealed: true } : {}),
    ...(row.extensible ? { extensible: true } : {}),
    ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
    ...(indexes.length > 0 ? { indexes } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    ...(Object.keys(operations).length > 0 ? { operations } : {}),
    ...(Object.keys(events).length > 0 ? { events } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
  };
}
