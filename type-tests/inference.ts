import {
  defineObjectType,
  type InferRelationships,
  type InferValues,
} from "../src/index.js";

const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
    aliases: { type: "string", multiple: true },
    deletedAt: { type: "datetime", nullable: true },
  },
  relationships: {
    manager: {
      target: "example.person",
      cardinality: "many-to-one",
      required: true,
    },
    reports: {
      target: "example.person",
      cardinality: "one-to-many",
    },
  },
} as const);

type PersonValues = InferValues<typeof Person>;
type PersonRelationships = InferRelationships<typeof Person>;

const valid: PersonValues = {
  firstName: "Stephen",
  age: 41,
  aliases: ["Steve"],
  deletedAt: null,
};
void valid;

const relationships: PersonRelationships = {
  manager: { id: "manager-1", type: "example.person" },
  reports: [{ id: "report-1", type: "example.person" }],
};
void relationships;

// @ts-expect-error firstName is required.
const missing: PersonValues = { age: 41 };
void missing;

// @ts-expect-error age is numeric.
const wrong: PersonValues = { firstName: "Stephen", age: "41" };
void wrong;

// @ts-expect-error manager is a required relationship.
const missingManager: PersonRelationships = {};
void missingManager;

const wrongTarget: PersonRelationships = {
  // @ts-expect-error relationship target is inferred as the literal object type id.
  manager: { id: "manager-1", type: "wrong.type" },
};
void wrongTarget;
