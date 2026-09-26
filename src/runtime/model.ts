export interface ObjectIdentity {
  readonly id: string;
  readonly type: string;
}

export interface ObjectReference extends ObjectIdentity {}

export type RelationshipValue = ObjectReference | readonly ObjectReference[];

export type ObjectState = "new" | "clean" | "dirty" | "deleted" | "detached";

export interface ChangeRecord {
  readonly before: unknown;
  readonly after: unknown;
}

export interface ObjectEvent {
  readonly name: string;
  readonly source: ObjectIdentity;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export interface RelationshipChangeRecord {
  readonly before: RelationshipValue | undefined;
  readonly after: RelationshipValue | undefined;
}

export interface ObjectSnapshot {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly version: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly relationships: Readonly<Record<string, RelationshipValue>>;
}

export const objectIdentityKey = (identity: ObjectIdentity): string =>
  `${identity.type}:${identity.id}`;

export const sameObjectIdentity = (left: ObjectIdentity, right: ObjectIdentity): boolean =>
  left.id === right.id && left.type === right.type;
