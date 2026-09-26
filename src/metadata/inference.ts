import type {
  AttributeDefinition,
  InheritedObjectTypeDefinition,
  ObjectTypeDefinition,
  RelationshipDefinition,
} from "./definitions.js";

export interface BuiltinAttributeTypeMap {
  string: string;
  integer: number;
  number: number;
  decimal: number;
  boolean: boolean;
  date: Date;
  datetime: Date;
  uuid: string;
  json: unknown;
  binary: Uint8Array;
}

export interface InferredObjectReference<TType extends string = string> {
  readonly id: string;
  readonly type: TType;
}

type BaseAttributeValue<A extends AttributeDefinition> =
  A["type"] extends keyof BuiltinAttributeTypeMap
    ? BuiltinAttributeTypeMap[A["type"]]
    : unknown;

type WithMultiplicity<A extends AttributeDefinition, V> =
  A["multiple"] extends true ? readonly V[] : V;

type WithNullability<A extends AttributeDefinition, V> =
  A["nullable"] extends true ? V | null : V;

export type InferAttributeValue<A extends AttributeDefinition> =
  WithNullability<A, WithMultiplicity<A, BaseAttributeValue<A>>>;

type RequiredAttributeKeys<D extends ObjectTypeDefinition> = {
  [K in keyof D["attributes"]]: D["attributes"][K] extends AttributeDefinition
    ? D["attributes"][K]["required"] extends true
      ? K
      : never
    : never;
}[keyof D["attributes"]];

type OptionalAttributeKeys<D extends ObjectTypeDefinition> = Exclude<
  keyof D["attributes"],
  RequiredAttributeKeys<D>
>;

type InferOwnValues<D extends ObjectTypeDefinition> = {
  [K in RequiredAttributeKeys<D>]: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
} & {
  [K in OptionalAttributeKeys<D>]?: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
};

export type InferValues<D extends ObjectTypeDefinition> =
  InferOwnValues<D>
  & (D extends InheritedObjectTypeDefinition<infer B> ? InferValues<B> : unknown);

type WritableAttributeKeys<D extends ObjectTypeDefinition> = {
  [K in keyof D["attributes"]]: D["attributes"][K] extends AttributeDefinition
    ? D["attributes"][K]["computed"] extends { readonly resolver: string }
      ? never
      : K
    : never;
}[keyof D["attributes"]];

type RequiredWritableAttributeKeys<D extends ObjectTypeDefinition> = {
  [K in WritableAttributeKeys<D>]: D["attributes"][K] extends AttributeDefinition
    ? D["attributes"][K]["required"] extends true
      ? K
      : never
    : never;
}[WritableAttributeKeys<D>];

type OptionalWritableAttributeKeys<D extends ObjectTypeDefinition> = Exclude<
  WritableAttributeKeys<D>,
  RequiredWritableAttributeKeys<D>
>;

type InferOwnInputValues<D extends ObjectTypeDefinition> = {
  [K in RequiredWritableAttributeKeys<D>]: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
} & {
  [K in OptionalWritableAttributeKeys<D>]?: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
};

/** Values accepted when creating an object; computed attributes are excluded. */
export type InferInputValues<D extends ObjectTypeDefinition> =
  InferOwnInputValues<D>
  & (D extends InheritedObjectTypeDefinition<infer B> ? InferInputValues<B> : unknown);

export type InferRelationshipValue<R extends RelationshipDefinition> =
  R["cardinality"] extends "one-to-many" | "many-to-many"
    ? readonly InferredObjectReference<R["target"]>[]
    : InferredObjectReference<R["target"]>;

type RelationshipMap<D extends ObjectTypeDefinition> = NonNullable<D["relationships"]>;

type RequiredRelationshipKeys<D extends ObjectTypeDefinition> = {
  [K in keyof RelationshipMap<D>]: RelationshipMap<D>[K] extends RelationshipDefinition
    ? RelationshipMap<D>[K]["required"] extends true
      ? K
      : never
    : never;
}[keyof RelationshipMap<D>];

type OptionalRelationshipKeys<D extends ObjectTypeDefinition> = Exclude<
  keyof RelationshipMap<D>,
  RequiredRelationshipKeys<D>
>;

type InferOwnRelationships<D extends ObjectTypeDefinition> = {
  [K in RequiredRelationshipKeys<D>]: RelationshipMap<D>[K] extends RelationshipDefinition
    ? InferRelationshipValue<RelationshipMap<D>[K]>
    : never;
} & {
  [K in OptionalRelationshipKeys<D>]?: RelationshipMap<D>[K] extends RelationshipDefinition
    ? InferRelationshipValue<RelationshipMap<D>[K]>
    : never;
};

/** Compile-time relationship shape inferred from literal object metadata. */
export type InferRelationships<D extends ObjectTypeDefinition> =
  InferOwnRelationships<D>
  & (D extends InheritedObjectTypeDefinition<infer B> ? InferRelationships<B> : unknown);
