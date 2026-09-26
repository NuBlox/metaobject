import assert from "node:assert/strict";
import test from "node:test";
import {
  BehaviorRegistry,
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectBehaviorRuntime,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineDerivedObjectType,
  defineObjectType,
} from "../dist/index.js";

function basicRuntime(definitions, behaviors) {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  for (const definition of definitions) objects.register(definition);
  objects.validateHierarchy();
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `object-${++id}`);
  const storage = new MemoryStorageAdapter();
  const validator = new Validator(undefined, behaviors);
  const repository = new MetaObjectRepository(storage, factory, validator, { behaviors });
  return { types, objects, factory, storage, validator, repository };
}

test("repository executes save and delete lifecycle hooks around validation and persistence", async () => {
  const calls = [];
  const behaviors = new BehaviorRegistry()
    .registerHook("lifecycle.beforeSave", ({ object }) => {
      calls.push(`beforeSave:${object.state}`);
      object.set("audit", "prepared");
    })
    .registerHook("lifecycle.beforeValidate", ({ object }) => calls.push(`beforeValidate:${object.get("audit")}`))
    .registerHook("lifecycle.afterValidate", ({ object }) => calls.push(`afterValidate:${object.state}`))
    .registerHook("lifecycle.afterSave", ({ object }) => calls.push(`afterSave:${object.state}:v${object.version}`))
    .registerHook("lifecycle.beforeDelete", ({ object }) => calls.push(`beforeDelete:${object.state}`))
    .registerHook("lifecycle.afterDelete", ({ object }) => calls.push(`afterDelete:${object.state}`));

  const Record = defineObjectType({
    id: "integrity.record",
    name: "Record",
    version: 1,
    attributes: {
      name: { type: "string", required: true },
      audit: { type: "string" },
    },
    hooks: [
      { id: "before-save", phase: "beforeSave", handler: "lifecycle.beforeSave" },
      { id: "before-validate", phase: "beforeValidate", handler: "lifecycle.beforeValidate" },
      { id: "after-validate", phase: "afterValidate", handler: "lifecycle.afterValidate" },
      { id: "after-save", phase: "afterSave", handler: "lifecycle.afterSave" },
      { id: "before-delete", phase: "beforeDelete", handler: "lifecycle.beforeDelete" },
      { id: "after-delete", phase: "afterDelete", handler: "lifecycle.afterDelete" },
    ],
  });
  const { factory, repository } = basicRuntime([Record], behaviors);
  const object = factory.create(Record, { name: "Example" });

  await repository.save(object);
  assert.deepEqual(calls, [
    "beforeSave:new",
    "beforeValidate:prepared",
    "afterValidate:new",
    "afterSave:clean:v1",
  ]);

  calls.length = 0;
  await repository.delete(object);
  assert.deepEqual(calls, ["beforeDelete:clean", "afterDelete:deleted"]);
});

test("saveAll is atomic when a later update has a stale version", async () => {
  const Item = defineObjectType({
    id: "integrity.atomic-item",
    name: "AtomicItem",
    version: 1,
    attributes: { value: { type: "integer", required: true } },
  });
  const { factory, repository } = basicRuntime([Item]);
  const first = factory.create(Item, { value: 1 });
  const second = factory.create(Item, { value: 2 });
  await repository.saveAll([first, second]);

  const staleFirst = await repository.find({ id: first.id, type: Item.id });
  const staleSecond = await repository.find({ id: second.id, type: Item.id });
  const currentSecond = await repository.find({ id: second.id, type: Item.id });
  currentSecond.set("value", 20);
  await repository.save(currentSecond);

  staleFirst.set("value", 10);
  staleSecond.set("value", 200);
  await assert.rejects(() => repository.saveAll([staleFirst, staleSecond]), /concurrency conflict/i);

  const persistedFirst = await repository.find({ id: first.id, type: Item.id });
  const persistedSecond = await repository.find({ id: second.id, type: Item.id });
  assert.equal(persistedFirst.get("value"), 1);
  assert.equal(persistedFirst.version, 1);
  assert.equal(persistedSecond.get("value"), 20);
  assert.equal(persistedSecond.version, 2);
  assert.equal(staleFirst.state, "dirty");
  assert.equal(staleSecond.state, "dirty");
});

test("unique attributes declared on a base type are enforced across sibling subtypes", async () => {
  const Entity = defineObjectType({
    id: "integrity.entity",
    name: "Entity",
    version: 1,
    abstract: true,
    attributes: { code: { type: "string", required: true, unique: true } },
  });
  const Employee = defineDerivedObjectType(Entity, {
    id: "integrity.employee",
    name: "Employee",
    version: 1,
    baseType: Entity.id,
    attributes: { employeeNumber: { type: "string" } },
  });
  const Supplier = defineDerivedObjectType(Entity, {
    id: "integrity.supplier",
    name: "Supplier",
    version: 1,
    baseType: Entity.id,
    attributes: { supplierNumber: { type: "string" } },
  });
  const { factory, repository } = basicRuntime([Entity, Employee, Supplier]);
  await repository.save(factory.create(Employee, { code: "SHARED" }));
  await assert.rejects(
    () => repository.save(factory.create(Supplier, { code: "SHARED" })),
    /Unique constraint 'integrity.entity.code'.*conflicts/,
  );
});

test("composite unique indexes are enforced and incomplete tuples do not collide", async () => {
  const ExternalRef = defineObjectType({
    id: "integrity.external-ref",
    name: "ExternalRef",
    version: 1,
    attributes: {
      system: { type: "string" },
      externalId: { type: "string", nullable: true },
    },
    indexes: [
      { name: "ux-system-external-id", unique: true, attributes: [{ attribute: "system" }, { attribute: "externalId" }] },
    ],
  });
  const { factory, repository } = basicRuntime([ExternalRef]);
  await repository.save(factory.create(ExternalRef, { system: "erp", externalId: "100" }));
  await assert.rejects(
    () => repository.save(factory.create(ExternalRef, { system: "erp", externalId: "100" })),
    /ux-system-external-id/,
  );
  await repository.saveAll([
    factory.create(ExternalRef, { system: "erp", externalId: null }),
    factory.create(ExternalRef, { system: "erp", externalId: null }),
  ]);
});

test("atomic saveAll evaluates uniqueness against final batch state and allows value swaps", async () => {
  const Code = defineObjectType({
    id: "integrity.swap",
    name: "Swap",
    version: 1,
    attributes: { code: { type: "string", required: true, unique: true } },
  });
  const { factory, repository } = basicRuntime([Code]);
  const left = factory.create(Code, { code: "A" });
  const right = factory.create(Code, { code: "B" });
  await repository.saveAll([left, right]);

  const editLeft = await repository.find({ id: left.id, type: Code.id });
  const editRight = await repository.find({ id: right.id, type: Code.id });
  editLeft.set("code", "B");
  editRight.set("code", "A");
  await repository.saveAll([editLeft, editRight]);

  assert.equal((await repository.find({ id: left.id, type: Code.id })).get("code"), "B");
  assert.equal((await repository.find({ id: right.id, type: Code.id })).get("code"), "A");
});

test("computed cache reuses values until object state changes", () => {
  let calculations = 0;
  const Calculated = defineObjectType({
    id: "integrity.calculated",
    name: "Calculated",
    version: 1,
    attributes: {
      quantity: { type: "integer", required: true },
      unitPrice: { type: "decimal", required: true },
      note: { type: "string" },
      total: {
        type: "decimal",
        computed: { resolver: "calculated.total", dependencies: ["quantity", "unitPrice"], cache: true },
      },
    },
  });
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  objects.register(Calculated);
  const factory = new ObjectFactory(objects, types, () => "calculated-1");
  const behaviors = new BehaviorRegistry().registerComputed("calculated.total", ({ object }) => {
    calculations += 1;
    return object.get("quantity") * object.get("unitPrice");
  });
  const runtime = new ObjectBehaviorRuntime(behaviors, types);
  const object = factory.create(Calculated, { quantity: 2, unitPrice: 5 });

  assert.equal(runtime.read(object, "total"), 10);
  assert.equal(runtime.read(object, "total"), 10);
  assert.equal(calculations, 1);

  object.set("note", "changed");
  assert.equal(runtime.read(object, "total"), 10);
  assert.equal(calculations, 2);
  assert.equal(runtime.read(object, "total"), 10);
  assert.equal(calculations, 2);

  runtime.invalidate(object, "total");
  assert.equal(runtime.read(object, "total"), 10);
  assert.equal(calculations, 3);
});
