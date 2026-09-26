import {
  defineDerivedObjectType,
  defineObjectType,
  type InferRelationships,
  type InferValues,
} from "../src/index.js";

const Party = defineObjectType({
  id: "party",
  name: "Party",
  version: 1,
  attributes: {
    name: { type: "string", required: true },
  },
  relationships: {
    owner: { target: "organisation", cardinality: "many-to-one", required: true },
  },
} as const);

const Employee = defineDerivedObjectType(Party, {
  id: "employee",
  name: "Employee",
  version: 1,
  baseType: "party",
  attributes: {
    employeeNumber: { type: "string", required: true },
  },
} as const);

type EmployeeValues = InferValues<typeof Employee>;
type EmployeeRelationships = InferRelationships<typeof Employee>;

const valid: EmployeeValues = {
  name: "Stephen",
  employeeNumber: "E-001",
};
void valid;

const inheritedRelationship: EmployeeRelationships = {
  owner: { id: "org-1", type: "organisation" },
};
void inheritedRelationship;

// @ts-expect-error inherited name remains required.
const missingInherited: EmployeeValues = { employeeNumber: "E-001" };
void missingInherited;

// @ts-expect-error derived employeeNumber remains required.
const missingDerived: EmployeeValues = { name: "Stephen" };
void missingDerived;

defineDerivedObjectType(Party, {
  id: "wrong",
  name: "Wrong",
  version: 1,
  // @ts-expect-error baseType must match the provided base metadata id.
  baseType: "another",
  attributes: {},
} as const);
