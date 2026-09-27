import {
  AttributeTypeNotFoundError,
  ConcurrencyError,
  METAOBJECT_PUBLIC_API_VERSION,
  MemoryStorageAdapter,
  MetaObjectError,
  MetaObjectRepository,
  MetadataError,
  ObjectTypeNotFoundError,
  ObjectTypeRegistry,
  ValidationError,
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
const registry: ObjectTypeRegistry = new ObjectTypeRegistry();
const storage: StorageAdapter = new MemoryStorageAdapter();
const repository: MetaObjectRepository = new MetaObjectRepository(registry, storage);

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
