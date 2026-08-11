#!/usr/bin/env node
/**
 * Thin launcher: re-exec entry with --experimental-strip-types so workspace
 * packages that export TypeScript source (ADR-0012) load under Node ≥22.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/cli.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", entry, ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
