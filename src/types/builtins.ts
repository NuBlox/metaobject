import type { AttributeType } from "./attribute-type.js";
import { TypeRegistry } from "./type-registry.js";

const identity = <T>(value: T): T => value;

export const StringType: AttributeType<string> = {
  name: "string",
  validate: (value): value is string => typeof value === "string",
  serialize: identity,
  deserialize(value) {
    if (typeof value !== "string") throw new TypeError("Expected string.");
    return value;
  },
};

export const IntegerType: AttributeType<number> = {
  name: "integer",
  validate: (value): value is number => typeof value === "number" && Number.isSafeInteger(value),
  serialize: identity,
  deserialize(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("Expected safe integer.");
    return value;
  },
};

export const NumberType: AttributeType<number> = {
  name: "number",
  validate: (value): value is number => typeof value === "number" && Number.isFinite(value),
  serialize: identity,
  deserialize(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Expected finite number.");
    return value;
  },
};

export const DecimalType: AttributeType<number> = { ...NumberType, name: "decimal" };

export const BooleanType: AttributeType<boolean> = {
  name: "boolean",
  validate: (value): value is boolean => typeof value === "boolean",
  serialize: identity,
  deserialize(value) {
    if (typeof value !== "boolean") throw new TypeError("Expected boolean.");
    return value;
  },
};

function dateType(name: "date" | "datetime"): AttributeType<Date> {
  return {
    name,
    validate: (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()),
    serialize: (value) => value.toISOString(),
    deserialize(value) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
      if (typeof value !== "string") throw new TypeError(`Expected ISO ${name} string.`);
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid ${name}.`);
      return date;
    },
    equals: (left, right) => left.getTime() === right.getTime(),
  };
}

export const DateType = dateType("date");
export const DateTimeType = dateType("datetime");

export const UuidType: AttributeType<string> = {
  name: "uuid",
  validate: (value): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  serialize: identity,
  deserialize(value) {
    if (typeof value !== "string") throw new TypeError("Expected UUID string.");
    if (!this.validate(value)) throw new TypeError("Invalid UUID.");
    return value;
  },
};

export const JsonType: AttributeType<unknown> = {
  name: "json",
  validate: (_value): _value is unknown => true,
  serialize: identity,
  deserialize: identity,
};

export const BinaryType: AttributeType<Uint8Array> = {
  name: "binary",
  validate: (value): value is Uint8Array => value instanceof Uint8Array,
  serialize: (value) => Array.from(value),
  deserialize(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      throw new TypeError("Expected byte array.");
    }
    return Uint8Array.from(value as number[]);
  },
  equals: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]),
};

export function createDefaultTypeRegistry(): TypeRegistry {
  return new TypeRegistry()
    .register(StringType)
    .register(IntegerType)
    .register(NumberType)
    .register(DecimalType)
    .register(BooleanType)
    .register(DateType)
    .register(DateTimeType)
    .register(UuidType)
    .register(JsonType)
    .register(BinaryType);
}
