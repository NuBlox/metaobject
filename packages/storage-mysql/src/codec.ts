import { MetadataError } from "@nublox/metaobject";

type SpecialNumber = "NaN" | "Infinity" | "-Infinity" | "-0";

type EncodedNode =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "special-number"; readonly value: SpecialNumber }
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "array"; readonly value: readonly EncodedNode[] }
  | { readonly kind: "object"; readonly value: Readonly<Record<string, EncodedNode>> };

interface EncodedEnvelope {
  readonly format: 1;
  readonly value: EncodedNode;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function encodeNode(value: unknown): EncodedNode {
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "bigint") return { kind: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { kind: "special-number", value: "NaN" };
    if (value === Infinity) return { kind: "special-number", value: "Infinity" };
    if (value === -Infinity) return { kind: "special-number", value: "-Infinity" };
    if (Object.is(value, -0)) return { kind: "special-number", value: "-0" };
    return { kind: "number", value };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new MetadataError("Cannot persist an invalid Date value.");
    return { kind: "date", value: value.toISOString() };
  }
  if (Array.isArray(value)) return { kind: "array", value: value.map(encodeNode) };
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MetadataError(
        `Unsupported persisted object prototype '${prototype?.constructor?.name ?? "unknown"}'.`,
      );
    }
    const encoded: Record<string, EncodedNode> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) encoded[key] = encodeNode(item);
    return { kind: "object", value: encoded };
  }
  throw new MetadataError(`Unsupported persisted value type '${typeof value}'.`);
}

function decodeNode(node: unknown): unknown {
  if (!isRecord(node) || typeof node.kind !== "string") throw new MetadataError("Invalid MySQL snapshot encoding.");
  switch (node.kind) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof node.value !== "boolean") break;
      return node.value;
    case "string":
      if (typeof node.value !== "string") break;
      return node.value;
    case "number":
      if (typeof node.value !== "number") break;
      return node.value;
    case "special-number":
      if (node.value === "NaN") return Number.NaN;
      if (node.value === "Infinity") return Infinity;
      if (node.value === "-Infinity") return -Infinity;
      if (node.value === "-0") return -0;
      break;
    case "bigint":
      if (typeof node.value !== "string") break;
      return BigInt(node.value);
    case "date":
      if (typeof node.value !== "string") break;
      return new Date(node.value);
    case "array":
      if (!Array.isArray(node.value)) break;
      return node.value.map(decodeNode);
    case "object": {
      if (!isRecord(node.value)) break;
      const decoded: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node.value)) decoded[key] = decodeNode(item);
      return decoded;
    }
  }
  throw new MetadataError(`Invalid MySQL snapshot encoding for kind '${node.kind}'.`);
}

export function encodeRecord(value: Readonly<Record<string, unknown>>): string {
  const envelope: EncodedEnvelope = { format: 1, value: encodeNode(value) };
  return JSON.stringify(envelope);
}

export function decodeRecord(value: unknown): Record<string, unknown> {
  let envelope: unknown = value;
  if (typeof value === "string") {
    try {
      envelope = JSON.parse(value) as unknown;
    } catch (error) {
      throw new MetadataError(`Invalid JSON returned from MySQL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(envelope) || envelope.format !== 1 || !("value" in envelope)) {
    throw new MetadataError("Unsupported MySQL snapshot encoding format.");
  }
  const decoded = decodeNode(envelope.value);
  if (!isRecord(decoded)) throw new MetadataError("Persisted snapshot record did not decode to an object.");
  return decoded;
}
