# Code generation

M7 turns `ObjectTypeDefinition` metadata into portable source and schema artifacts without making generated output the source of truth. Metadata remains authoritative; generated files are reproducible projections of that metadata.

## First-party generators

The package exports:

- `generateTypeScriptInterface()` — value interfaces with relationship reference typing.
- `generateTypeScriptCreateInput()` — create-input interfaces that omit computed attributes by default and treat defaulted attributes as optional inputs.
- `generateTypeScriptClass()` — immutable typed model wrappers with object-type and schema-version constants.
- `generateTypeScriptModule()` — interface, create-input and immutable model class in one TypeScript module.
- `generateTypeScriptValidator()` — dependency-free validator source with built-in constraint support and hooks for custom constraints.
- `generateJsonSchema()` / `generateJsonSchemaText()` — JSON Schema draft 2020-12 with NuBlox extensions.

## JSON Schema mapping

Built-in attribute types map to standard JSON Schema types and formats where possible:

| MetaObject type | JSON Schema |
| --- | --- |
| `string` | `type: string` |
| `integer` | `type: integer` |
| `number`, `decimal` | `type: number` |
| `boolean` | `type: boolean` |
| `date` | `type: string`, `format: date` |
| `datetime` | `type: string`, `format: date-time` |
| `uuid` | `type: string`, `format: uuid` |
| `binary` | `type: string`, `contentEncoding: base64` |
| `json` | unconstrained JSON value |

Built-in `minLength`, `maxLength`, `range` and `pattern` constraints map to native JSON Schema keywords. Custom constraints are retained under `x-nublox-constraints` so no metadata is lost.

Relationships are emitted as typed object-reference schemas containing `id` and a `type` constant, with relationship semantics retained under `x-nublox-relationship`.

## Generated validators

Generated validators are intentionally dependency-free. They validate plain objects and emit `{ code, path, message }` issues.

Built-in checks include:

- required values
- nullability
- primitive attribute types
- minimum/maximum length
- numeric minimum/maximum
- regular-expression patterns

Custom constraint metadata is not silently ignored. The generated validator accepts a callback registry keyed by constraint type. If a required custom evaluator is absent, validation emits `UNKNOWN_CONSTRAINT`.

Computed attributes are omitted from generated input validation because they are resolved by runtime behaviours rather than supplied by callers.

## ArtifactGeneratorRegistry

`ArtifactGeneratorRegistry` is the extension boundary for packaging code generation workflows.

```ts
const registry = createDefaultArtifactGeneratorRegistry();

const artifacts = registry.generateMany(
  ["typescript", "typescript-validator", "json-schema", "metadata-snapshot"],
  [definition],
);
```

The default registry contains:

- `typescript`
- `typescript-interface`
- `typescript-create-input`
- `typescript-class`
- `typescript-validator`
- `json-schema`
- `metadata-snapshot`

Each generated artifact includes a stable name, kind, media type, content, object type id and schema version.

## Adapter-specific generation

Database and platform adapters should register their own artifact generators instead of adding dialect logic to the core package.

For example, `@nublox/metaobject-storage-mysql` can register a `mysql` generator that emits DDL, indexes, typed value-table mappings or query-plan artifacts:

```ts
registry.register("mysql", ({ definitions }) =>
  definitions.map((definition) => ({
    name: `${definition.id}.sql`,
    kind: "mysql-ddl",
    mediaType: "application/sql",
    content: compileMySqlDefinition(definition),
    objectTypeId: definition.id,
    objectTypeVersion: definition.version,
  })),
);
```

This keeps `@nublox/metaobject` database-neutral while giving adapters a first-class code-generation integration point.

## Reproducibility

Generated source should normally be treated as a build artifact. The recommended flow is:

```text
Persisted metadata
      │
      ▼
ObjectTypeDefinition
      │
      ▼
ArtifactGeneratorRegistry
      │
      ├── TypeScript
      ├── validators
      ├── JSON Schema
      ├── metadata snapshots
      └── adapter-specific artifacts
```

Regenerate artifacts whenever published metadata changes rather than editing generated output by hand.
