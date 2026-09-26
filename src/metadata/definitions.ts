export type RelationshipCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many";

export type RelationshipOwnership = "none" | "source" | "target";

export type RelationshipKind = "association" | "aggregation" | "composition";

/**
 * Action applied when an object participating in a relationship is deleted.
 *
 * - restrict: deletion is rejected while the relationship exists.
 * - cascade:  deletion propagates across the relationship.
 * - detach:   the relationship is removed and the other object is retained.
 */
export type ReferentialAction = "restrict" | "cascade" | "detach";

export interface ConstraintDefinition {
  /** Registry key for the constraint evaluator. */
  readonly type: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number;
  readonly pattern?: string;
  readonly flags?: string;
  readonly message?: string;
  /** Additional serializable evaluator-specific parameters. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ComputedAttributeDefinition {
  /** Registry key for a synchronous computation handler. */
  readonly resolver: string;
  readonly dependencies?: readonly string[];
  /** Cache the computed value until the object mutates. Defaults to false. */
  readonly cache?: boolean;
}

export interface ObjectRuleDefinition {
  readonly id: string;
  /** Registry key for an object-level validation evaluator. */
  readonly type: string;
  readonly message?: string;
  readonly severity?: "error" | "warning" | "info";
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface OperationDefinition {
  /** Registry key for the operation handler. */
  readonly handler: string;
  readonly description?: string;
}

export interface EventDefinition {
  readonly description?: string;
}

export type HookPhase =
  | "beforeValidate"
  | "afterValidate"
  | "beforeSave"
  | "afterSave"
  | "beforeDelete"
  | "afterDelete";

export interface HookDefinition {
  readonly id: string;
  readonly phase: HookPhase;
  /** Registry key for the hook handler. */
  readonly handler: string;
}

export interface AttributeDefinition {
  readonly type: string;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly multiple?: boolean;
  readonly readOnly?: boolean;
  readonly unique?: boolean;
  readonly default?: unknown;
  readonly constraints?: readonly ConstraintDefinition[];
  /** Virtual value resolved by the behaviour registry rather than stored directly. */
  readonly computed?: ComputedAttributeDefinition;
}

export interface RelationshipDefinition {
  /** Object type accepted by this relationship. */
  readonly target: string;

  /** Cardinality as observed from the source object. */
  readonly cardinality: RelationshipCardinality;

  /** Whether at least one target is required. */
  readonly required?: boolean;

  /** Name of the relationship on the target object that points back to the source. */
  readonly inverse?: string;

  /** Which end conceptually owns the relationship. */
  readonly ownership?: RelationshipOwnership;

  /** Semantic relationship kind. Composition gives the source exclusive lifecycle ownership. */
  readonly kind?: RelationshipKind;

  /** Whether target order is semantically significant for to-many relationships. */
  readonly ordered?: boolean;

  /** Policy when the source object is deleted. Defaults to detach. */
  readonly onSourceDelete?: ReferentialAction;

  /** Policy when a referenced target object is deleted. Defaults to detach. */
  readonly onTargetDelete?: ReferentialAction;
}

export interface IndexAttributeDefinition {
  readonly attribute: string;
  readonly direction?: "asc" | "desc";
}

export interface IndexDefinition {
  readonly name: string;
  readonly unique?: boolean;
  readonly attributes: readonly IndexAttributeDefinition[];
}

export type AttributeDefinitionMap = Readonly<Record<string, AttributeDefinition>>;
export type RelationshipDefinitionMap = Readonly<Record<string, RelationshipDefinition>>;

declare const inheritedObjectTypeBrand: unique symbol;

/** Type-only link retained by defineDerivedObjectType for recursive TypeScript inference. */
export interface InheritedObjectTypeDefinition<B extends ObjectTypeDefinition = ObjectTypeDefinition> {
  readonly [inheritedObjectTypeBrand]: B;
}

export interface ObjectTypeDefinition<
  A extends AttributeDefinitionMap = AttributeDefinitionMap,
  R extends RelationshipDefinitionMap = RelationshipDefinitionMap,
> {
  readonly id: string;
  readonly name: string;
  readonly namespace?: string;
  readonly version: number;
  readonly baseType?: string;
  readonly abstract?: boolean;
  readonly sealed?: boolean;
  readonly extensible?: boolean;
  readonly attributes: A;
  readonly relationships?: R;
  readonly indexes?: readonly IndexDefinition[];
  readonly rules?: readonly ObjectRuleDefinition[];
  readonly operations?: Readonly<Record<string, OperationDefinition>>;
  readonly events?: Readonly<Record<string, EventDefinition>>;
  readonly hooks?: readonly HookDefinition[];
}

export interface ResolvedObjectTypeDefinition extends ObjectTypeDefinition {
  /** Root-to-leaf object type ids, including this object type. */
  readonly lineage: readonly string[];
  /** The unflattened metadata definition registered for this exact type. */
  readonly declared: ObjectTypeDefinition;
}

export function defineObjectType<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
  return Object.freeze(definition);
}

/**
 * Define a derived type while retaining its base metadata in the TypeScript type
 * system. The brand is type-only; serialized metadata still contains only baseType.
 */
export function defineDerivedObjectType<
  const B extends ObjectTypeDefinition,
  const D extends ObjectTypeDefinition & { readonly baseType: B["id"] },
>(base: B, definition: D): Readonly<D & InheritedObjectTypeDefinition<B>> {
  if (definition.baseType !== base.id) {
    throw new TypeError(`Derived object type '${definition.id}' declares baseType '${definition.baseType}' but was defined from '${base.id}'.`);
  }
  return Object.freeze(definition) as Readonly<D & InheritedObjectTypeDefinition<B>>;
}
