#!/usr/bin/env node
// Runner de smoke tests: compila server/tests/smoke.ts con esbuild (solo módulos
// puros, sin dependencias externas) y lo ejecuta con node. Funciona en cualquier
// entorno, incluso sin node_modules instalado. Uso: npm run smoke
import { execSync } from "node:child_process";
try {
  execSync("npx esbuild server/tests/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/vf-smoke.mjs", { stdio: "pipe" });
} catch (e) {
  console.error("✗ No compiló el smoke test:\n", (e.stdout || e.stderr || "").toString().slice(0, 500));
  process.exit(1);
}
try {
  execSync("node /tmp/vf-smoke.mjs", { stdio: "inherit" });
} catch {
  process.exit(1);
}
