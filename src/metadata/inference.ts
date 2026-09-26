import type { AttributeDefinition, ObjectTypeDefinition } from "./definitions.js";

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

export type InferValues<D extends ObjectTypeDefinition> = {
  [K in RequiredAttributeKeys<D>]: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
} & {
  [K in OptionalAttributeKeys<D>]?: D["attributes"][K] extends AttributeDefinition
    ? InferAttributeValue<D["attributes"][K]>
    : never;
};
