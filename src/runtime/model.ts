export interface ObjectIdentity {
  readonly id: string;
  readonly type: string;
}

export interface ObjectReference extends ObjectIdentity {}

export type ObjectState = "new" | "clean" | "dirty" | "deleted" | "detached";

export interface ChangeRecord {
  readonly before: unknown;
  readonly after: unknown;
}

export interface ObjectSnapshot {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly version: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly relationships: Readonly<Record<string, ObjectReference | readonly ObjectReference[]>>;
}
