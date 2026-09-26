import { MetadataError } from "../errors/errors.js";
import type {
  AttributeDefinition,
  EventDefinition,
  HookDefinition,
  IndexDefinition,
  ObjectRuleDefinition,
  ObjectTypeDefinition,
  OperationDefinition,
  RelationshipDefinition,
} from "../metadata/definitions.js";

export type SchemaChangeImpact = "compatible" | "requires-migration" | "breaking";

export type SchemaChangeKind =
  | "object-property-changed"
  | "attribute-added"
  | "attribute-removed"
  | "attribute-changed"
  | "relationship-added"
  | "relationship-removed"
  | "relationship-changed"
  | "index-added"
  | "index-removed"
  | "index-changed"
  | "rule-added"
  | "rule-removed"
  | "rule-changed"
  | "operation-added"
  | "operation-removed"
  | "operation-changed"
  | "event-added"
  | "event-removed"
  | "event-changed"
  | "hook-added"
  | "hook-removed"
  | "hook-changed";

export interface SchemaChange {
  readonly kind: SchemaChangeKind;
  readonly path: string;
  readonly impact: SchemaChangeImpact;
  readonly reason: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface SchemaDiff {
  readonly objectTypeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly impact: SchemaChangeImpact;
  readonly changes: readonly SchemaChange[];
}

const impactRank: Readonly<Record<SchemaChangeImpact, number>> = {
  compatible: 0,
  "requires-migration": 1,
  breaking: 2,
};

function worstImpact(changes: readonly SchemaChange[]): SchemaChangeImpact {
  return changes.reduce<SchemaChangeImpact>(
    (worst, change) => impactRank[change.impact] > impactRank[worst] ? change.impact : worst,
    "compatible",
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function change(
  kind: SchemaChangeKind,
  path: string,
  impact: SchemaChangeImpact,
  reason: string,
  before?: unknown,
  after?: unknown,
): SchemaChange {
  return {
    kind,
    path,
    impact,
    reason,
    ...(before === undefined ? {} : { before: structuredClone(before) }),
    ...(after === undefined ? {} : { after: structuredClone(after) }),
  };
}

function classifyAddedAttribute(attribute: AttributeDefinition): Pick<SchemaChange, "impact" | "reason"> {
  if (attribute.computed) {
    return { impact: "compatible", reason: "Computed attributes do not require persisted values for existing objects." };
  }
  if (attribute.required && attribute.default === undefined) {
    return { impact: "breaking", reason: "Existing objects do not contain the newly required attribute." };
  }
  if (attribute.required) {
    return { impact: "requires-migration", reason: "Existing objects should be backfilled with the declared default." };
  }
  return { impact: "compatible", reason: "Optional attributes do not invalidate existing objects." };
}

function classifyAttributeChange(
  before: AttributeDefinition,
  after: AttributeDefinition,
): Pick<SchemaChange, "impact" | "reason"> {
  if (before.type !== after.type) {
    return { impact: "breaking", reason: `Attribute type changed from '${before.type}' to '${after.type}'.` };
  }
  if (Boolean(before.multiple) !== Boolean(after.multiple)) {
    return { impact: "breaking", reason: "Attribute multiplicity changed." };
  }
  if (Boolean(before.computed) !== Boolean(after.computed)) {
    return { impact: "breaking", reason: "Attribute storage semantics changed between persisted and computed." };
  }
  if (!before.required && after.required) {
    return after.default === undefined
      ? { impact: "breaking", reason: "Attribute became required without a backfill default." }
      : { impact: "requires-migration", reason: "Attribute became required and existing objects should be backfilled." };
  }
  if (before.nullable && !after.nullable) {
    return after.default === undefined
      ? { impact: "breaking", reason: "Null values are no longer accepted." }
      : { impact: "requires-migration", reason: "Existing null values must be backfilled before nullability is tightened." };
  }
  if (!before.readOnly && after.readOnly) {
    return { impact: "breaking", reason: "Attribute became read-only for callers." };
  }
  if (!before.unique && after.unique) {
    return { impact: "requires-migration", reason: "Existing values must be checked for uniqueness before enforcement." };
  }
  if (!equal(before.constraints ?? [], after.constraints ?? [])) {
    return { impact: "requires-migration", reason: "Constraint changes require validation of existing values." };
  }
  return { impact: "compatible", reason: "The attribute contract changed without invalidating stored values." };
}

function classifyAddedRelationship(relationship: RelationshipDefinition): Pick<SchemaChange, "impact" | "reason"> {
  return relationship.required
    ? { impact: "breaking", reason: "Existing objects do not contain the newly required relationship." }
    : { impact: "compatible", reason: "Optional relationships do not invalidate existing objects." };
}

function classifyRelationshipChange(
  before: RelationshipDefinition,
  after: RelationshipDefinition,
): Pick<SchemaChange, "impact" | "reason"> {
  if (before.target !== after.target) {
    return { impact: "breaking", reason: `Relationship target changed from '${before.target}' to '${after.target}'.` };
  }
  if (before.cardinality !== after.cardinality) {
    return { impact: "breaking", reason: `Relationship cardinality changed from '${before.cardinality}' to '${after.cardinality}'.` };
  }
  if (!before.required && after.required) {
    return { impact: "breaking", reason: "Relationship became required for existing objects." };
  }
  if (before.kind !== after.kind || before.ownership !== after.ownership) {
    return { impact: "breaking", reason: "Relationship ownership/lifecycle semantics changed." };
  }
  if (before.inverse !== after.inverse) {
    return { impact: "requires-migration", reason: "Inverse relationship data may need to be resynchronized." };
  }
  if (!before.ordered && after.ordered) {
    return { impact: "requires-migration", reason: "Existing to-many values need deterministic ordering." };
  }
  return { impact: "compatible", reason: "Relationship policy changed without changing target/cardinality ownership." };
}

function diffNamedMap<T>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
  handlers: {
    readonly added: (name: string, value: T) => SchemaChange;
    readonly removed: (name: string, value: T) => SchemaChange;
    readonly changed: (name: string, previous: T, next: T) => SchemaChange;
  },
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  for (const [name, value] of Object.entries(before)) {
    if (!(name in after)) changes.push(handlers.removed(name, value));
  }
  for (const [name, value] of Object.entries(after)) {
    if (!(name in before)) changes.push(handlers.added(name, value));
    else if (!equal(before[name], value)) changes.push(handlers.changed(name, before[name]!, value));
  }
  return changes;
}

function diffIndexes(before: readonly IndexDefinition[], after: readonly IndexDefinition[]): SchemaChange[] {
  const beforeMap = Object.fromEntries(before.map((index) => [index.name, index]));
  const afterMap = Object.fromEntries(after.map((index) => [index.name, index]));
  return diffNamedMap(beforeMap, afterMap, {
    added: (name, value) => change("index-added", `indexes.${name}`, "requires-migration", "A persisted index must be created.", undefined, value),
    removed: (name, value) => change("index-removed", `indexes.${name}`, "requires-migration", "A persisted index should be removed.", value),
    changed: (name, previous, next) => change("index-changed", `indexes.${name}`, "requires-migration", "The persisted index definition changed.", previous, next),
  });
}

function diffRules(before: readonly ObjectRuleDefinition[], after: readonly ObjectRuleDefinition[]): SchemaChange[] {
  const beforeMap = Object.fromEntries(before.map((rule) => [rule.id, rule]));
  const afterMap = Object.fromEntries(after.map((rule) => [rule.id, rule]));
  return diffNamedMap(beforeMap, afterMap, {
    added: (name, value) => change("rule-added", `rules.${name}`, "requires-migration", "Existing objects should be validated against the new rule.", undefined, value),
    removed: (name, value) => change("rule-removed", `rules.${name}`, "compatible", "Removing a rule relaxes validation.", value),
    changed: (name, previous, next) => change("rule-changed", `rules.${name}`, "requires-migration", "Existing objects should be validated against the changed rule.", previous, next),
  });
}

function diffSimpleMap<T>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
  noun: "operation" | "event",
): SchemaChange[] {
  return diffNamedMap(before, after, {
    added: (name, value) => change(`${noun}-added`, `${noun}s.${name}`, "compatible", `A new ${noun} was added.`, undefined, value),
    removed: (name, value) => change(`${noun}-removed`, `${noun}s.${name}`, "breaking", `Removing a declared ${noun} can break consumers.`, value),
    changed: (name, previous, next) => change(`${noun}-changed`, `${noun}s.${name}`, "compatible", `The ${noun} implementation metadata changed.`, previous, next),
  });
}

function diffHooks(before: readonly HookDefinition[], after: readonly HookDefinition[]): SchemaChange[] {
  const beforeMap = Object.fromEntries(before.map((hook) => [hook.id, hook]));
  const afterMap = Object.fromEntries(after.map((hook) => [hook.id, hook]));
  return diffNamedMap(beforeMap, afterMap, {
    added: (name, value) => change("hook-added", `hooks.${name}`, "compatible", "A runtime lifecycle hook was added.", undefined, value),
    removed: (name, value) => change("hook-removed", `hooks.${name}`, "compatible", "A runtime lifecycle hook was removed.", value),
    changed: (name, previous, next) => change("hook-changed", `hooks.${name}`, "compatible", "Runtime hook metadata changed.", previous, next),
  });
}

/** Calculate a semantic, database-neutral difference between two versions of one object type. */
export function diffObjectTypes(before: ObjectTypeDefinition, after: ObjectTypeDefinition): SchemaDiff {
  if (before.id !== after.id) {
    throw new MetadataError(`Cannot diff different object types '${before.id}' and '${after.id}'.`);
  }
  if (after.version <= before.version) {
    throw new MetadataError(`Schema evolution requires a higher target version than ${before.version}.`);
  }

  const changes: SchemaChange[] = [];
  const topLevel: readonly [keyof Pick<ObjectTypeDefinition, "name" | "namespace" | "baseType" | "abstract" | "sealed" | "extensible">, SchemaChangeImpact, string][] = [
    ["name", "compatible", "Display name changed."],
    ["namespace", "compatible", "Namespace changed while the stable object type id remained unchanged."],
    ["baseType", "breaking", "Base type changed, altering inherited metadata and assignability."],
    ["abstract", before.abstract && !after.abstract ? "compatible" : "breaking", "Abstract instantiation semantics changed."],
    ["sealed", "compatible", "Sealed inheritance semantics changed."],
    ["extensible", before.extensible && !after.extensible ? "breaking" : "compatible", "Extensibility semantics changed."],
  ];
  for (const [property, impact, reason] of topLevel) {
    if (!equal(before[property], after[property])) {
      changes.push(change("object-property-changed", property, impact, reason, before[property], after[property]));
    }
  }

  changes.push(...diffNamedMap(before.attributes, after.attributes, {
    added: (name, value) => {
      const classification = classifyAddedAttribute(value);
      return change("attribute-added", `attributes.${name}`, classification.impact, classification.reason, undefined, value);
    },
    removed: (name, value) => change("attribute-removed", `attributes.${name}`, "breaking", "Removing an attribute breaks stored data and callers using it.", value),
    changed: (name, previous, next) => {
      const classification = classifyAttributeChange(previous, next);
      return change("attribute-changed", `attributes.${name}`, classification.impact, classification.reason, previous, next);
    },
  }));

  changes.push(...diffNamedMap(before.relationships ?? {}, after.relationships ?? {}, {
    added: (name, value) => {
      const classification = classifyAddedRelationship(value);
      return change("relationship-added", `relationships.${name}`, classification.impact, classification.reason, undefined, value);
    },
    removed: (name, value) => change("relationship-removed", `relationships.${name}`, "breaking", "Removing a relationship breaks stored references and callers using it.", value),
    changed: (name, previous, next) => {
      const classification = classifyRelationshipChange(previous, next);
      return change("relationship-changed", `relationships.${name}`, classification.impact, classification.reason, previous, next);
    },
  }));

  changes.push(...diffIndexes(before.indexes ?? [], after.indexes ?? []));
  changes.push(...diffRules(before.rules ?? [], after.rules ?? []));
  changes.push(...diffSimpleMap<OperationDefinition>(before.operations ?? {}, after.operations ?? {}, "operation"));
  changes.push(...diffSimpleMap<EventDefinition>(before.events ?? {}, after.events ?? {}, "event"));
  changes.push(...diffHooks(before.hooks ?? [], after.hooks ?? []));

  return {
    objectTypeId: before.id,
    fromVersion: before.version,
    toVersion: after.version,
    impact: worstImpact(changes),
    changes,
  };
}
