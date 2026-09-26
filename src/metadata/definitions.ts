export type RelationshipCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many";

export type RelationshipOwnership = "none" | "source" | "target";

/**
 * Action applied when an object participating in a relationship is deleted.
 *
 * - restrict: deletion is rejected while the relationship exists.
 * - cascade:  deletion propagates across the relationship.
 * - detach:   the relationship is removed and the other object is retained.
 */
export type ReferentialAction = "restrict" | "cascade" | "detach";

export interface ConstraintDefinition {
  readonly type: "minLength" | "maxLength" | "range" | "pattern";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number;
  readonly pattern?: string;
  readonly flags?: string;
  readonly message?: string;
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
}

export function defineObjectType<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
  return Object.freeze(definition);
}
