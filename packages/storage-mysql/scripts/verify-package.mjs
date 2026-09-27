import { execFileSync } from "node:child_process";

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

console.log(`Verified npm package manifest: ${files.length} files, ${result.size} bytes.`);
