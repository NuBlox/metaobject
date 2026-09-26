import { MetadataError } from "../errors/errors.js";
import type { SchemaChange, SchemaChangeImpact, SchemaChangeKind, SchemaDiff } from "./schema-evolution.js";

export type MigrationStepKind =
  | "apply-metadata"
  | "validate-existing-data"
  | "backfill-existing-data"
  | "transform-existing-data"
  | "rebuild-index"
  | "remove-obsolete-data"
  | "manual-review"
  | string;

export interface MigrationStep {
  readonly id: string;
  readonly kind: MigrationStepKind;
  readonly path: string;
  readonly description: string;
  /** A blocking step must succeed before the target schema can be activated. */
  readonly blocking: boolean;
  readonly changeKind: SchemaChangeKind;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface MigrationPlan {
  readonly objectTypeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly impact: SchemaChangeImpact;
  readonly requiresManualReview: boolean;
  readonly steps: readonly MigrationStep[];
}

export interface MigrationPlanningContext {
  readonly diff: SchemaDiff;
  readonly change: SchemaChange;
  readonly ordinal: number;
}

/** Supplemental adapter/application migration planning hook. */
export type MigrationPlanningHook = (context: MigrationPlanningContext) => readonly MigrationStep[];

function stepId(ordinal: number, kind: MigrationStepKind, path: string): string {
  return `${String(ordinal + 1).padStart(3, "0")}:${kind}:${path}`;
}

function defaultStep(change: SchemaChange, ordinal: number): MigrationStep {
  const common = {
    id: "",
    path: change.path,
    changeKind: change.kind,
  } as const;

  if (change.impact === "breaking") {
    const kind = "manual-review" as const;
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: true,
      description: `${change.reason} Define an explicit compatibility or data-conversion strategy before activation.`,
    };
  }

  if (change.kind === "index-added" || change.kind === "index-removed" || change.kind === "index-changed") {
    const kind = "rebuild-index" as const;
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: true,
      description: change.reason,
    };
  }

  if (change.kind === "rule-added" || change.kind === "rule-changed") {
    const kind = "validate-existing-data" as const;
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: true,
      description: change.reason,
    };
  }

  if (change.kind === "attribute-added" && change.impact === "requires-migration") {
    const kind = "backfill-existing-data" as const;
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: true,
      description: change.reason,
      payload: { target: change.after },
    };
  }

  if (
    change.kind === "attribute-changed"
    || change.kind === "relationship-changed"
  ) {
    const kind = change.impact === "requires-migration" ? "transform-existing-data" : "apply-metadata";
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: change.impact === "requires-migration",
      description: change.reason,
      ...(change.impact === "requires-migration" ? { payload: { before: change.before, after: change.after } } : {}),
    };
  }

  if (change.kind === "attribute-removed" || change.kind === "relationship-removed") {
    const kind = "remove-obsolete-data" as const;
    return {
      ...common,
      id: stepId(ordinal, kind, change.path),
      kind,
      blocking: true,
      description: change.reason,
      payload: { previous: change.before },
    };
  }

  const kind = "apply-metadata" as const;
  return {
    ...common,
    id: stepId(ordinal, kind, change.path),
    kind,
    blocking: false,
    description: change.reason,
  };
}

/**
 * Convert a semantic schema diff into a database-neutral ordered migration plan.
 * Adapter packages can add dialect-specific supplemental steps by change kind.
 */
export class MigrationPlanner {
  readonly #hooks = new Map<SchemaChangeKind | "*", MigrationPlanningHook[]>();

  register(changeKind: SchemaChangeKind | "*", hook: MigrationPlanningHook): this {
    const hooks = this.#hooks.get(changeKind) ?? [];
    hooks.push(hook);
    this.#hooks.set(changeKind, hooks);
    return this;
  }

  plan(diff: SchemaDiff): MigrationPlan {
    const steps: MigrationStep[] = [];
    diff.changes.forEach((change, ordinal) => {
      steps.push(defaultStep(change, ordinal));
      for (const hook of [...(this.#hooks.get(change.kind) ?? []), ...(this.#hooks.get("*") ?? [])]) {
        const supplemental = hook({ diff, change, ordinal });
        for (const candidate of supplemental) {
          if (!candidate.id.trim()) throw new MetadataError("Migration hook produced a step without an id.");
          steps.push(candidate);
        }
      }
    });

    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) throw new MetadataError(`Duplicate migration step id '${step.id}'.`);
      ids.add(step.id);
    }

    return {
      objectTypeId: diff.objectTypeId,
      fromVersion: diff.fromVersion,
      toVersion: diff.toVersion,
      impact: diff.impact,
      requiresManualReview: steps.some((step) => step.kind === "manual-review"),
      steps,
    };
  }
}
