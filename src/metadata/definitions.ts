export type RelationshipCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many";

export type RelationshipOwnership = "none" | "source" | "target";

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
  readonly target: string;
  readonly cardinality: RelationshipCardinality;
  readonly required?: boolean;
  readonly inverse?: string;
  readonly ownership?: RelationshipOwnership;
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
