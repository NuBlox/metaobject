import { execFileSync } from "node:child_process";

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

const result = JSON.parse(output)[0];
if (!result || !Array.isArray(result.files)) throw new Error("npm pack did not return a file manifest.");

const files = result.files.map((entry) => entry.path).sort();
const forbiddenPrefixes = ["src/", "test/", "type-tests/", "docs/", ".github/", "scripts/"];
const forbidden = files.filter((path) => forbiddenPrefixes.some((prefix) => path.startsWith(prefix)));
if (forbidden.length > 0) {
  throw new Error(`Package contains non-public source/build files: ${forbidden.join(", ")}`);
}

for (const required of ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"]) {
  if (!files.includes(required)) throw new Error(`Package is missing required file '${required}'.`);
}

const unexpectedTopLevel = files.filter((path) => !path.startsWith("dist/") && path !== "package.json" && path !== "README.md");
if (unexpectedTopLevel.length > 0) {
  throw new Error(`Package contains unexpected top-level files: ${unexpectedTopLevel.join(", ")}`);
}

console.log(`Verified npm package manifest: ${files.length} files, ${result.size} bytes.`);
