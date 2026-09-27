import {
  AttributeTypeNotFoundError,
  ConcurrencyError,
  METAOBJECT_PUBLIC_API_VERSION,
  MemoryStorageAdapter,
  MetaObjectError,
  MetaObjectRepository,
  MetadataError,
  ObjectFactory,
  ObjectTypeNotFoundError,
  ObjectTypeRegistry,
  ValidationError,
  Validator,
  createDefaultTypeRegistry,
  defineDerivedObjectType,
  defineObjectType,
  type MetaObjectPublicApiVersion,
  type ObjectTypeDefinition,
  type StorageAdapter,
} from "../src/index.js";

const base = defineObjectType({
  id: "public-api.base",
  name: "Public API Base",
  version: 1,
  attributes: {
    id: { type: "string", required: true },
  },
});

const derived = defineDerivedObjectType(base, {
  id: "public-api.derived",
  name: "Public API Derived",
  version: 1,
  baseType: base.id,
  attributes: {
    label: { type: "string" },
  },
});

const definition: ObjectTypeDefinition = derived;
const types = createDefaultTypeRegistry();
const registry: ObjectTypeRegistry = new ObjectTypeRegistry(types);
registry.register(base);
registry.register(derived);
registry.validateRelationships();

const factory = new ObjectFactory(registry, types, () => "public-api-object");
const storage: StorageAdapter = new MemoryStorageAdapter();
const repository: MetaObjectRepository = new MetaObjectRepository(storage, factory, new Validator());

const apiVersion: MetaObjectPublicApiVersion = METAOBJECT_PUBLIC_API_VERSION;
const errors: MetaObjectError[] = [
  new MetadataError("metadata"),
  new ValidationError("validation"),
  new ConcurrencyError("concurrency"),
  new ObjectTypeNotFoundError("object-type"),
  new AttributeTypeNotFoundError("attribute-type"),
];

void definition;
void repository;
void apiVersion;
void errors;
