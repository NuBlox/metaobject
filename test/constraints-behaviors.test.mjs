import assert from "node:assert/strict";
import test from "node:test";
import {
  BehaviorRegistry,
  ConstraintRegistry,
  EventBus,
  ObjectBehaviorRuntime,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "../dist/index.js";

function setup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Invoice = defineObjectType({
    id: "example.invoice",
    name: "Invoice",
    version: 1,
    attributes: {
      quantity: { type: "integer", required: true, constraints: [{ type: "positive" }] },
      unitPrice: { type: "decimal", required: true, constraints: [{ type: "positive" }] },
      discount: { type: "decimal", default: 0 },
      total: { type: "decimal", computed: { resolver: "invoice.total", dependencies: ["quantity", "unitPrice", "discount"] } },
    },
    rules: [{ id: "discount", type: "discountWithinSubtotal" }],
    operations: {
      approve: { handler: "invoice.approve" },
    },
    events: {
      approved: { description: "Invoice approved" },
    },
    hooks: [
      { id: "audit-before-validation", phase: "beforeValidate", handler: "audit.beforeValidate" },
    ],
  });
  objects.register(Invoice);

  const behaviors = new BehaviorRegistry();
  const calls = [];
  behaviors
    .registerComputed("invoice.total", ({ object }) =>
      object.get("quantity") * object.get("unitPrice") - object.get("discount"),
    )
    .registerOperation("invoice.approve", ({ object }) => ({ approved: true, id: object.id }))
    .registerHook("audit.beforeValidate", () => calls.push("beforeValidate"));

  const constraints = new ConstraintRegistry();
  constraints
    .register("positive", (value) => typeof value === "number" && value > 0 || "Value must be positive.")
    .register("discountWithinSubtotal", (_values, { object }) => {
      const subtotal = object.get("quantity") * object.get("unitPrice");
      return object.get("discount") <= subtotal || "Discount cannot exceed subtotal.";
    });

  const validator = new Validator(constraints, behaviors);
  const factory = new ObjectFactory(objects, types, () => "invoice-1");
  const bus = new EventBus();
  const runtime = new ObjectBehaviorRuntime(behaviors, types, bus);
  return { Invoice, factory, validator, runtime, bus, calls };
}

test("evaluates custom attribute and cross-field constraints", () => {
  const { factory, validator } = setup();
  const invoice = factory.create("example.invoice", { quantity: -1, unitPrice: 10, discount: 20 });
  const result = validator.validate(invoice);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((item) => item.code).sort(), ["DISCOUNT_WITHIN_SUBTOTAL", "POSITIVE"]);
});

test("calculates computed attributes without persisting them", () => {
  const { factory, runtime } = setup();
  const invoice = factory.create("example.invoice", { quantity: 3, unitPrice: 12.5, discount: 2.5 });
  assert.equal(runtime.read(invoice, "total"), 35);
  assert.equal(invoice.get("total"), undefined);
  assert.equal("total" in invoice.snapshot().values, false);
});

test("invokes metadata-defined operations", () => {
  const { factory, runtime } = setup();
  const invoice = factory.create("example.invoice", { quantity: 1, unitPrice: 10 });
  const result = runtime.invoke(invoice, "approve");
  assert.deepEqual(result, { approved: true, id: "invoice-1" });
});

test("runs validation hooks", () => {
  const { factory, validator, calls } = setup();
  const invoice = factory.create("example.invoice", { quantity: 1, unitPrice: 10 });
  validator.validate(invoice);
  assert.deepEqual(calls, ["beforeValidate"]);
});

test("emits only declared domain events", () => {
  const { factory, runtime, bus } = setup();
  const invoice = factory.create("example.invoice", { quantity: 1, unitPrice: 10 });
  const events = [];
  bus.on("approved", (event) => events.push(event));
  runtime.emit(invoice, "approved", { by: "tester" });
  assert.equal(events.length, 1);
  assert.equal(events[0].object.id, invoice.id);
  assert.deepEqual(events[0].payload, { by: "tester" });
  assert.throws(() => runtime.emit(invoice, "undeclared"), /Unknown event/);
});
