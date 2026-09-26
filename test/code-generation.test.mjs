import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactGeneratorRegistry,
  createDefaultArtifactGeneratorRegistry,
  defineObjectType,
  generateJsonSchema,
  generateTypeScriptClass,
  generateTypeScriptCreateInput,
  generateTypeScriptInterface,
  generateTypeScriptModule,
  generateTypeScriptValidator,
} from "../dist/index.js";

const Product = defineObjectType({
  id: "example.product",
  name: "Product Item",
  namespace: "example",
  version: 3,
  extensible: false,
  attributes: {
    sku: {
      type: "string",
      required: true,
      unique: true,
      constraints: [
        { type: "minLength", value: 3 },
        { type: "pattern", pattern: "^[A-Z0-9-]+$" },
      ],
    },
    quantity: { type: "integer", required: true, constraints: [{ type: "range", minimum: 0, maximum: 999 }] },
    unitPrice: { type: "decimal", required: true },
    tags: { type: "string", multiple: true, default: [] },
    total: { type: "decimal", computed: { resolver: "product.total", dependencies: ["quantity", "unitPrice"] } },
    externalCode: { type: "string", constraints: [{ type: "externalCode", parameters: { system: "erp" } }] },
  },
  relationships: {
    owner: { target: "example.person", cardinality: "many-to-one", required: true },
  },
});

test("generates TypeScript interfaces, create input and immutable model classes", () => {
  const values = generateTypeScriptInterface(Product);
  assert.match(values, /export interface Product_Item/);
  assert.match(values, /sku: string/);
  assert.match(values, /owner: ObjectReference<"example.person">/);

  const input = generateTypeScriptCreateInput(Product);
  assert.match(input, /export interface Product_ItemCreateInput/);
  assert.match(input, /sku: string/);
  assert.match(input, /tags\?: readonly string\[\]/);
  assert.doesNotMatch(input, /total/);

  const model = generateTypeScriptClass(Product);
  assert.match(model, /export class Product_ItemModel/);
  assert.match(model, /readonly values: Readonly<Product_Item>/);
  assert.match(model, /objectTypeId = "example.product"/);
  assert.match(model, /schemaVersion = 3/);

  const module = generateTypeScriptModule(Product);
  assert.match(module, /Product_ItemCreateInput/);
  assert.match(module, /Product_ItemModel/);
});

test("generates JSON Schema with constraints, references and NuBlox extensions", () => {
  const schema = generateJsonSchema(Product);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "urn:nublox:metaobject:example.product:v3");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["$id", "$type", "$schemaVersion", "sku", "quantity", "unitPrice", "owner"]);

  assert.equal(schema.properties.sku.minLength, 3);
  assert.equal(schema.properties.sku.pattern, "^[A-Z0-9-]+$");
  assert.equal(schema.properties.sku["x-nublox-unique"], true);
  assert.equal(schema.properties.quantity.minimum, 0);
  assert.equal(schema.properties.quantity.maximum, 999);
  assert.equal(schema.properties.total.readOnly, true);
  assert.equal(schema.properties.owner.properties.type.const, "example.person");
  assert.equal(schema.properties.owner["x-nublox-object-reference"], true);
  assert.equal(schema.properties.externalCode["x-nublox-constraints"][0].type, "externalCode");
});

test("generates dependency-free validator source with custom constraint hooks", () => {
  const source = generateTypeScriptValidator(Product);
  assert.match(source, /export function validateProduct_Item/);
  assert.match(source, /code: "REQUIRED"/);
  assert.match(source, /code: "MIN_LENGTH"/);
  assert.match(source, /code: "MAXIMUM"/);
  assert.match(source, /customConstraints\["externalCode"\]/);
  assert.match(source, /UNKNOWN_CONSTRAINT/);
  assert.doesNotMatch(source, /object\["total"\]/);
});

test("default artifact registry emits portable first-party artifacts", () => {
  const registry = createDefaultArtifactGeneratorRegistry();
  assert.deepEqual(registry.names(), [
    "json-schema",
    "metadata-snapshot",
    "typescript",
    "typescript-class",
    "typescript-create-input",
    "typescript-interface",
    "typescript-validator",
  ]);

  const artifacts = registry.generateMany(["typescript", "json-schema", "metadata-snapshot"], [Product]);
  assert.equal(artifacts.length, 3);
  assert.deepEqual(artifacts.map((artifact) => artifact.kind), ["typescript", "json-schema", "metadata-snapshot"]);
  assert.equal(artifacts[0].objectTypeId, Product.id);
  assert.equal(artifacts[0].objectTypeVersion, Product.version);
  assert.match(artifacts[1].content, /urn:nublox:metaobject:example.product:v3/);
});

test("adapter packages can register their own artifact generators", () => {
  const registry = new ArtifactGeneratorRegistry();
  registry.register("mysql", ({ definitions }) => definitions.map((definition) => ({
    name: `${definition.id}.sql`,
    kind: "mysql-ddl",
    mediaType: "application/sql",
    content: `-- MySQL artifact for ${definition.id}`,
    objectTypeId: definition.id,
    objectTypeVersion: definition.version,
  })));

  const [artifact] = registry.generate("mysql", [Product]);
  assert.equal(artifact.kind, "mysql-ddl");
  assert.match(artifact.content, /example.product/);
  assert.throws(() => registry.register("mysql", () => []), /already registered/);
});
