import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type {
  MetaQuery,
  QueryExpression,
  QueryOrder,
  QueryPlan,
} from "./query.js";

const systemPaths = new Set(["$id", "$type", "$version", "$schemaVersion"]);

function collectExpressionPaths(expression: QueryExpression | undefined, paths: Set<string>): void {
  if (!expression) return;
  if ("path" in expression) {
    paths.add(expression.path);
    return;
  }
  if ("and" in expression) {
    for (const child of expression.and) collectExpressionPaths(child, paths);
    return;
  }
  if ("or" in expression) {
    for (const child of expression.or) collectExpressionPaths(child, paths);
    return;
  }
  collectExpressionPaths(expression.not, paths);
}

export class QueryPlanner {
  constructor(private readonly objects: ObjectTypeRegistry) {}

  plan(query: MetaQuery): QueryPlan {
    if (!this.objects.has(query.objectType)) {
      throw new MetadataError(`Unknown query object type '${query.objectType}'.`);
    }
    if (query.page && (!Number.isSafeInteger(query.page.first) || query.page.first < 1)) {
      throw new MetadataError("Cursor page size 'first' must be a positive integer.");
    }

    const paths = new Set<string>();
    collectExpressionPaths(query.where, paths);
    for (const projection of query.select ?? []) paths.add(projection.path);
    for (const order of query.orderBy ?? []) paths.add(order.path);
    for (const aggregate of query.aggregates ?? []) {
      if (aggregate.path) paths.add(aggregate.path);
      if (aggregate.function !== "count" && !aggregate.path) {
        throw new MetadataError(`Aggregate '${aggregate.as}' requires a path.`);
      }
    }

    const relationshipPaths = new Set<string>();
    for (const path of paths) this.validatePath(query.objectType, path, relationshipPaths);

    const rootTypes = query.includeSubtypes
      ? [query.objectType, ...this.objects.subtypes(query.objectType).map((definition) => definition.id)]
      : [query.objectType];

    const stableOrder: QueryOrder[] = [...(query.orderBy ?? [])];
    if (!stableOrder.some((order) => order.path === "$id")) {
      stableOrder.push({ path: "$id", direction: "asc", nulls: "last" });
    }

    return Object.freeze({
      query,
      rootTypes: Object.freeze(rootTypes),
      paths: Object.freeze([...paths]),
      relationshipPaths: Object.freeze([...relationshipPaths]),
      stableOrder: Object.freeze(stableOrder),
    });
  }

  private validatePath(rootType: string, path: string, relationships: Set<string>): void {
    if (!path.trim()) throw new MetadataError("Query path cannot be empty.");
    if (systemPaths.has(path)) return;

    const segments = path.split(".");
    let typeId = rootType;
    const traversed: string[] = [];

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (!segment) throw new MetadataError(`Invalid query path '${path}'.`);
      const definition = this.objects.resolve(typeId);
      const attribute = definition.attributes[segment];
      const relationship = definition.relationships?.[segment];
      const terminal = index === segments.length - 1;

      if (attribute) {
        if (!terminal) {
          throw new MetadataError(`Query path '${path}' cannot traverse through attribute '${segment}'.`);
        }
        return;
      }
      if (!relationship) {
        throw new MetadataError(`Query path '${path}' references unknown member '${typeId}.${segment}'.`);
      }

      traversed.push(segment);
      relationships.add(traversed.join("."));
      typeId = relationship.target;
      if (terminal) return;
    }
  }
}
