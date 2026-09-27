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

interface TraversalState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

export const MYSQL_CODEC_MAX_DEPTH = 128;
export const MYSQL_CODEC_MAX_NODES = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function visit(state: TraversalState, depth: number): void {
  if (depth > MYSQL_CODEC_MAX_DEPTH) {
    throw new MetadataError(`Persisted value exceeds maximum nesting depth ${MYSQL_CODEC_MAX_DEPTH}.`);
  }
  state.nodes += 1;
  if (state.nodes > MYSQL_CODEC_MAX_NODES) {
    throw new MetadataError(`Persisted value exceeds maximum node count ${MYSQL_CODEC_MAX_NODES}.`);
  }
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function rejectEnumerableSymbols(value: object): void {
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) {
      throw new MetadataError("Cannot persist enumerable symbol-keyed properties.");
    }
  }
}

function encodeNode(value: unknown, state: TraversalState, depth: number): EncodedNode {
  visit(state, depth);
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
  if (typeof value !== "object") {
    throw new MetadataError(`Unsupported persisted value type '${typeof value}'.`);
  }

  if (state.ancestors.has(value)) throw new MetadataError("Cannot persist cyclic object graphs.");
  state.ancestors.add(value);
  try {
    rejectEnumerableSymbols(value);

    if (Array.isArray(value)) {
      const encoded: EncodedNode[] = [];
      const enumerableKeys = Object.keys(value);
      if (enumerableKeys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new MetadataError("Cannot persist arrays with enumerable non-index properties.");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) throw new MetadataError("Cannot persist sparse arrays.");
        if (!("value" in descriptor)) throw new MetadataError("Cannot persist accessor-backed array elements.");
        encoded.push(encodeNode(descriptor.value, state, depth + 1));
      }
      return { kind: "array", value: encoded };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MetadataError(
        `Unsupported persisted object prototype '${prototype?.constructor?.name ?? "unknown"}'.`,
      );
    }

    const encoded: Record<string, EncodedNode> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new MetadataError(`Cannot persist accessor-backed property '${key}'.`);
      }
      defineOwn(encoded, key, encodeNode(descriptor.value, state, depth + 1));
    }
    return { kind: "object", value: encoded };
  } finally {
    state.ancestors.delete(value);
  }
}

function decodeNode(node: unknown, state: TraversalState, depth: number): unknown {
  visit(state, depth);
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
      if (typeof node.value !== "number" || !Number.isFinite(node.value) || Object.is(node.value, -0)) break;
      return node.value;
    case "special-number":
      if (node.value === "NaN") return Number.NaN;
      if (node.value === "Infinity") return Infinity;
      if (node.value === "-Infinity") return -Infinity;
      if (node.value === "-0") return -0;
      break;
    case "bigint":
      if (typeof node.value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(node.value)) break;
      try {
        return BigInt(node.value);
      } catch {
        break;
      }
    case "date": {
      if (typeof node.value !== "string") break;
      const date = new Date(node.value);
      if (Number.isNaN(date.getTime()) || date.toISOString() !== node.value) break;
      return date;
    }
    case "array":
      if (!Array.isArray(node.value)) break;
      return node.value.map((item) => decodeNode(item, state, depth + 1));
    case "object": {
      if (!isRecord(node.value)) break;
      const decoded: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node.value)) {
        defineOwn(decoded, key, decodeNode(item, state, depth + 1));
      }
      return decoded;
    }
  }
  throw new MetadataError(`Invalid MySQL snapshot encoding for kind '${node.kind}'.`);
}

export function encodeRecord(value: Readonly<Record<string, unknown>>): string {
  if (!isRecord(value)) throw new MetadataError("Persisted snapshot values must be an object record.");
  const envelope: EncodedEnvelope = {
    format: 1,
    value: encodeNode(value, { nodes: 0, ancestors: new WeakSet<object>() }, 0),
  };
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
  const decoded = decodeNode(envelope.value, { nodes: 0, ancestors: new WeakSet<object>() }, 0);
  if (!isRecord(decoded)) throw new MetadataError("Persisted snapshot record did not decode to an object.");
  return decoded;
}
