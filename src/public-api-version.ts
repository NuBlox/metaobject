/**
 * Compatibility generation for the supported package root API.
 *
 * This is intentionally independent of the package release version. Consumers
 * that persist generated metadata or build adapters may record this value to
 * make their expected API generation explicit.
 */
export const METAOBJECT_PUBLIC_API_VERSION = "1" as const;

export type MetaObjectPublicApiVersion = typeof METAOBJECT_PUBLIC_API_VERSION;
