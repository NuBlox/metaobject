import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "metaobject-storage-mysql-consumer-"));
const expectedMetaObjectVersion = "1.1.0";

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packed = JSON.parse(packOutput)[0];
  if (!packed?.filename) throw new Error("npm pack did not produce a tarball.");

  writeFileSync(join(temp, "package.json"), JSON.stringify({
    name: "metaobject-storage-mysql-consumer-fixture",
    private: true,
    type: "module",
  }, null, 2));

  // The adapter is a Node.js package and @nublox/mysql exposes Node Buffer types.
  // Model a real strict TypeScript Node consumer by installing the Node declarations
  // explicitly instead of hiding declaration errors with skipLibCheck.
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      `./${packed.filename}`,
      "typescript@^5.8.3",
      "@types/node@^22.0.0",
    ],
    { cwd: temp, stdio: "inherit" },
  );

  const installedMetaObject = JSON.parse(readFileSync(
    join(temp, "node_modules", "@nublox", "metaobject", "package.json"),
    "utf8",
  ));
  if (installedMetaObject.version !== expectedMetaObjectVersion) {
    throw new Error(
      `Expected clean consumer to resolve @nublox/metaobject@${expectedMetaObjectVersion}, got ${installedMetaObject.version}.`,
    );
  }

  writeFileSync(join(temp, "consumer.mjs"), [
    'import { METAOBJECT_PUBLIC_API_VERSION } from "@nublox/metaobject";',
    'import {',
    '  MYSQL_METADATA_SCHEMA_VERSION,',
    '  MYSQL_STORAGE_SCHEMA_VERSION,',
    '  compileMySqlObjectQueryPlan,',
    '} from "@nublox/metaobject-storage-mysql";',
    '',
    'if (METAOBJECT_PUBLIC_API_VERSION !== "1") throw new Error("Unexpected MetaObject public API version");',
    'if (MYSQL_STORAGE_SCHEMA_VERSION !== 3) throw new Error("Unexpected storage schema version");',
    'if (MYSQL_METADATA_SCHEMA_VERSION !== 3) throw new Error("Unexpected metadata schema version");',
    '',
    'const plan = compileMySqlObjectQueryPlan("metaobject_objects", {',
    '  objectType: "consumer.item",',
    '  where: [{ attribute: "status", operator: "eq", value: "open" }],',
    '  limit: 10,',
    '});',
    '',
    'if (plan.pushedFilters.length !== 1) throw new Error("Expected equality filter pushdown");',
    'if (plan.residualFilters.length !== 0) throw new Error("Unexpected residual filter");',
    'if (!plan.paginationPushed) throw new Error("Expected pagination pushdown");',
    'if (!plan.sql.includes("object_type = ?")) throw new Error("Unexpected compiled query plan");',
  ].join("\n"));

  writeFileSync(join(temp, "consumer.ts"), [
    'import type { MetadataStore, StorageAdapter } from "@nublox/metaobject";',
    'import {',
    '  MYSQL_METADATA_SCHEMA_VERSION,',
    '  MYSQL_STORAGE_SCHEMA_VERSION,',
    '  MySqlMetadataStore,',
    '  MySqlStorageAdapter,',
    '  compileMySqlObjectQueryPlan,',
    '  type MySqlObjectQueryPlan,',
    '} from "@nublox/metaobject-storage-mysql";',
    '',
    'declare const storage: MySqlStorageAdapter;',
    'declare const metadata: MySqlMetadataStore;',
    'const storageContract: StorageAdapter = storage;',
    'const metadataContract: MetadataStore = metadata;',
    'const storageSchemaVersion: 3 = MYSQL_STORAGE_SCHEMA_VERSION;',
    'const metadataSchemaVersion: 3 = MYSQL_METADATA_SCHEMA_VERSION;',
    'const plan: MySqlObjectQueryPlan = compileMySqlObjectQueryPlan("metaobject_objects", {',
    '  objectType: "consumer.item",',
    '});',
    'void storageContract;',
    'void metadataContract;',
    'void storageSchemaVersion;',
    'void metadataSchemaVersion;',
    'void plan;',
  ].join("\n"));

  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      types: ["node"],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["consumer.ts"],
  }, null, 2));

  execFileSync(process.execPath, [join(temp, "consumer.mjs")], {
    cwd: temp,
    stdio: "inherit",
  });
  execFileSync(join(temp, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: temp,
    stdio: "inherit",
  });

  console.log(
    `Verified clean external ESM and TypeScript consumer installation for @nublox/metaobject-storage-mysql against @nublox/metaobject@${expectedMetaObjectVersion}.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
