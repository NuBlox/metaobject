import { DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS } from "../query/query-capabilities.js";
import type { ObjectQuery } from "../query/query.js";
import type { ObjectSnapshot } from "../runtime/model.js";
import { MemoryStorageAdapter } from "../storage/memory-storage-adapter.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import type { ConformanceCheckResult } from "./storage-adapter-conformance.js";

export interface QueryComparisonConformanceOptions {
  readonly createAdapter: () => StorageAdapter | Promise<StorageAdapter>;
  readonly createReferenceAdapter?: () => StorageAdapter | Promise<StorageAdapter>;
  readonly semanticsId?: string;
}

export interface QueryComparisonConformanceReport {
  readonly contract: "QueryComparisonSemantics";
  readonly semanticsId: string;
  readonly checks: readonly ConformanceCheckResult[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Query comparison conformance failure: ${message}`);
}

function snapshot(
  id: string,
  label: string,
  score: number,
  occurredAt: Date,
): ObjectSnapshot {
  return {
    id,
    type: "conformance.query-comparison",
    schemaVersion: 1,
    version: 0,
    values: { label, score, occurredAt },
    relationships: {},
  };
}

const DATASET = [
  snapshot("qcmp-01", "Z", -10, new Date("2026-01-04T00:00:00.000Z")),
  snapshot("qcmp-02", "a", 0, new Date("2026-01-02T00:00:00.000Z")),
  snapshot("qcmp-03", "á", 10, new Date("2026-01-03T00:00:00.000Z")),
  snapshot("qcmp-04", "😀", Infinity, new Date("2026-01-05T00:00:00.000Z")),
  snapshot("qcmp-05", "A", -Infinity, new Date("2026-01-01T00:00:00.000Z")),
  snapshot("qcmp-06", "zz", Number.NaN, new Date("invalid")),
] as const;

const QUERIES: readonly { readonly name: string; readonly query: ObjectQuery }[] = [
  {
    name: "Unicode code-point ascending order",
    query: {
      objectType: "conformance.query-comparison",
      orderBy: [{ attribute: "label", direction: "asc" }],
    },
  },
  {
    name: "Unicode code-point range predicate",
    query: {
      objectType: "conformance.query-comparison",
      where: [{ attribute: "label", operator: "gt", value: "Z" }],
      orderBy: [{ attribute: "label", direction: "asc" }],
    },
  },
  {
    name: "numeric ordering including infinities and NaN",
    query: {
      objectType: "conformance.query-comparison",
      orderBy: [{ attribute: "score", direction: "asc" }],
    },
  },
  {
    name: "numeric range predicate",
    query: {
      objectType: "conformance.query-comparison",
      where: [{ attribute: "score", operator: "gte", value: 0 }],
      orderBy: [{ attribute: "score", direction: "asc" }],
    },
  },
  {
    name: "Date ordering including invalid Date",
    query: {
      objectType: "conformance.query-comparison",
      orderBy: [{ attribute: "occurredAt", direction: "asc" }],
    },
  },
  {
    name: "ordered pagination",
    query: {
      objectType: "conformance.query-comparison",
      orderBy: [{ attribute: "label", direction: "desc" }],
      offset: 1,
      limit: 3,
    },
  },
] as const;

async function seed(adapter: StorageAdapter): Promise<void> {
  await adapter.saveBatch(DATASET.map((item) => ({ kind: "insert" as const, snapshot: item })));
}

function ids(rows: readonly ObjectSnapshot[]): readonly string[] {
  return rows.map((row) => row.id);
}

/**
 * Compares a target StorageAdapter against the in-memory reference implementation
 * for one named comparison policy. Production adapters should run this suite
 * before advertising ordered filter or attribute-ordering pushdown for that
 * policy.
 */
export async function runQueryComparisonConformance(
  options: QueryComparisonConformanceOptions,
): Promise<QueryComparisonConformanceReport> {
  const semanticsId = options.semanticsId ?? DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS;
  const reference = options.createReferenceAdapter
    ? await options.createReferenceAdapter()
    : new MemoryStorageAdapter();
  const target = await options.createAdapter();

  await seed(reference);
  await seed(target);

  const checks: ConformanceCheckResult[] = [];
  for (const vector of QUERIES) {
    const query = { ...vector.query, comparisonSemantics: semanticsId };
    const [expected, actual] = await Promise.all([
      reference.query(query),
      target.query(query),
    ]);
    const expectedIds = ids(expected);
    const actualIds = ids(actual);
    assert(
      JSON.stringify(actualIds) === JSON.stringify(expectedIds),
      `${vector.name}; expected ids ${JSON.stringify(expectedIds)}, received ${JSON.stringify(actualIds)}`,
    );
    checks.push({ name: vector.name, passed: true });
  }

  return {
    contract: "QueryComparisonSemantics",
    semanticsId,
    checks,
  };
}
