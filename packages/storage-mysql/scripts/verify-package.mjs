import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedRepository = "git+https://github.com/NuBlox/metaobject.git";
const expectedMetaObjectVersion = "1.0.0";
const isPrerelease = String(packageJson.version).includes("-");
const expectedDistTag = isPrerelease ? "next" : "latest";

if (packageJson.name !== "@nublox/metaobject-storage-mysql") throw new Error("Unexpected package name.");
if (packageJson.license !== "Apache-2.0") throw new Error("Package licence must remain Apache-2.0.");
if (packageJson.author !== "Stephen J T Spittal") throw new Error("Unexpected package author metadata.");
if (packageJson.repository?.url !== expectedRepository) {
  throw new Error(`Package repository.url must be '${expectedRepository}'.`);
}
if (packageJson.repository?.directory !== "packages/storage-mysql") {
  throw new Error("MySQL adapter repository.directory must remain packages/storage-mysql.");
}
if (packageJson.publishConfig?.access !== "public" || packageJson.publishConfig?.tag !== expectedDistTag) {
  throw new Error(`MySQL adapter publishConfig must enforce public access under the ${expectedDistTag} dist-tag.`);
}
if (packageJson.scripts?.prepublishOnly !== "npm run release:check") {
  throw new Error("prepublishOnly must enforce the complete release gate.");
}
if (packageJson.dependencies?.["@nublox/metaobject"] !== expectedMetaObjectVersion) {
  throw new Error(`MySQL adapter must target stable @nublox/metaobject@${expectedMetaObjectVersion}.`);
}

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

const result = JSON.parse(output)[0];
if (!result || !Array.isArray(result.files)) throw new Error("npm pack did not return a file manifest.");

const files = result.files.map((entry) => entry.path).sort();
const forbiddenPrefixes = ["src/", "test/", "scripts/"];
const forbidden = files.filter((path) => forbiddenPrefixes.some((prefix) => path.startsWith(prefix)));
if (forbidden.length > 0) {
  throw new Error(`Package contains non-public source/build files: ${forbidden.join(", ")}`);
}

for (const required of ["package.json", "README.md", "LICENSE", "NOTICE", "dist/index.js", "dist/index.d.ts"]) {
  if (!files.includes(required)) throw new Error(`Package is missing required file '${required}'.`);
}

const allowedTopLevel = new Set(["package.json", "README.md", "LICENSE", "NOTICE"]);
const unexpectedTopLevel = files.filter((path) => !path.startsWith("dist/") && !allowedTopLevel.has(path));
if (unexpectedTopLevel.length > 0) {
  throw new Error(`Package contains unexpected top-level files: ${unexpectedTopLevel.join(", ")}`);
}

console.log(`Verified npm package metadata and manifest: ${files.length} files, ${result.size} bytes.`);
