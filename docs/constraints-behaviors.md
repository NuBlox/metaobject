# Constraints and behaviours

M3 adds extensible validation and executable behaviour while keeping object metadata serializable.

## Design rule

Metadata contains stable names, parameters and declarations only. Executable JavaScript/TypeScript functions are registered at runtime. This allows object definitions to be stored later in JSON or database tables without serializing functions.

## Custom constraints

`ConstraintRegistry` contains built-in and custom evaluators.

```ts
const constraints = new ConstraintRegistry();
constraints.register("positive", (value) =>
  typeof value === "number" && value > 0 || "Value must be positive."
);
```

Attribute metadata references the registry key:

```ts
quantity: {
  type: "integer",
  constraints: [{ type: "positive" }]
}
```

Built-in constraint compatibility is preserved, including the established `MINIMUM`, `MAXIMUM`, `MIN_LENGTH`, `MAX_LENGTH` and `PATTERN` issue codes.

## Object rules

Cross-field validation is represented by object-level `rules` metadata. The evaluator receives the object in its constraint context, so it can inspect multiple attributes and relationships.

```ts
rules: [
  { id: "discount", type: "discountWithinSubtotal" }
]
```

Rules support `error`, `warning` and `info` severity. Only error issues make `ValidationResult.valid` false.

## Computed attributes

Computed attributes are virtual. Their metadata names a synchronous resolver:

```ts
total: {
  type: "decimal",
  computed: {
    resolver: "invoice.total",
    dependencies: ["quantity", "unitPrice", "discount"]
  }
}
```

Register the resolver:

```ts
behaviors.registerComputed("invoice.total", ({ object }) =>
  object.get("quantity") * object.get("unitPrice") - object.get("discount")
);
```

Read it through `ObjectBehaviorRuntime`:

```ts
runtime.read(invoice, "total");
```

Computed values are type-checked against their attribute definition and are not stored in object snapshots. `InferInputValues<T>` excludes computed attributes from compile-time create inputs.

## Operations

Operations are declared in metadata and resolved through `BehaviorRegistry`:

```ts
operations: {
  approve: { handler: "invoice.approve" }
}
```

```ts
behaviors.registerOperation("invoice.approve", ({ object, input }) => {
  // domain action
});

runtime.invoke(invoice, "approve", input);
```

Unknown operations or unregistered handlers fail explicitly.

## Hooks

Object metadata may declare named hook handlers for lifecycle phases:

- `beforeValidate`
- `afterValidate`
- `beforeSave`
- `afterSave`
- `beforeDelete`
- `afterDelete`

M3 wires validation hooks into `Validator`. Save/delete phases are metadata-ready for repository lifecycle integration in subsequent work.

```ts
hooks: [
  {
    id: "audit-before-validation",
    phase: "beforeValidate",
    handler: "audit.beforeValidate"
  }
]
```

## Events

Events must be declared by the object type:

```ts
events: {
  approved: { description: "Invoice approved" }
}
```

`ObjectBehaviorRuntime.emit()` rejects undeclared event names and publishes declared events through `EventBus`.

```ts
runtime.events.on("approved", event => {
  // consume event
});

runtime.emit(invoice, "approved", { by: "user-1" });
```

Listeners may subscribe to a specific event name or `*` for all events.

## Runtime components

- `ConstraintRegistry` — validation evaluator registry
- `Validator` — attribute, object-rule and relationship validation
- `BehaviorRegistry` — computed, operation and hook handlers
- `ObjectBehaviorRuntime` — computed reads, operation invocation and declared event emission
- `EventBus` — synchronous event publication

These components remain independent of any application domain or storage adapter.
