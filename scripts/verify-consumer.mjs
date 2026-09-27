import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "metaobject-consumer-"));
try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packed = JSON.parse(packOutput)[0];
  if (!packed?.filename) throw new Error("npm pack did not produce a tarball.");

  writeFileSync(join(temp, "package.json"), JSON.stringify({
    name: "metaobject-consumer-fixture",
    private: true,
    type: "module",
  }, null, 2));

  execFileSync("npm", ["install", "--ignore-scripts", `./${packed.filename}`, "typescript@^5.8.3"], {
    cwd: temp,
    stdio: "inherit",
  });

  writeFileSync(join(temp, "consumer.mjs"), [
    'import { METAOBJECT_PUBLIC_API_VERSION, defineObjectType } from "@nublox/metaobject";',
    'if (METAOBJECT_PUBLIC_API_VERSION !== "1") throw new Error("Unexpected public API version");',
    'const value = defineObjectType({ id: "consumer.item", name: "Consumer Item", version: 1, attributes: {} });',
    'if (value.id !== "consumer.item") throw new Error("Runtime root import failed");',
  ].join("\n"));

  writeFileSync(join(temp, "consumer.ts"), [
    'import { METAOBJECT_PUBLIC_API_VERSION, defineObjectType, type ObjectTypeDefinition, type StorageAdapter } from "@nublox/metaobject";',
    'const definition: ObjectTypeDefinition = defineObjectType({ id: "consumer.typed", name: "Consumer Typed", version: 1, attributes: {} });',
    'const apiVersion: "1" = METAOBJECT_PUBLIC_API_VERSION;',
    'declare const adapter: StorageAdapter;',
    'void definition; void apiVersion; void adapter;',
  ].join("\n"));

  writeFileSync(join(temp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["consumer.ts"],
  }, null, 2));

  execFileSync(process.execPath, [join(temp, "consumer.mjs")], { cwd: temp, stdio: "inherit" });
  execFileSync(join(temp, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: temp, stdio: "inherit" });
  console.log("Verified clean runtime and TypeScript consumer installation.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
