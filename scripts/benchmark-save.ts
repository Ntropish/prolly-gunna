import { spawn } from "node:child_process";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* --- paths ------------------------------------------------------------- */
const benchmarksDir = path.join(__dirname, "..", "benchmarks");
const compiledBenchJS = path.join(
  __dirname,
  "benchmark.js" // ← emitted by `tsc -p tsconfig.scripts.json`
);
/* ---------------------------------------------------------------------- */

/* ensure output folder exists */
fs.mkdirSync(benchmarksDir, { recursive: true });

/* timestamped log file */
const stamp = new Date().toISOString().replace(/:/g, "-");
const outFile = path.join(benchmarksDir, `${stamp}.txt`);
const fileStream = fs.createWriteStream(outFile);

console.log("🚀  Starting benchmark…");
console.log(`📝  Saving output to: ${outFile}\n`);

/* spawn plain Node — no ts-node, no extra compiler */
const child = spawn(
  process.execPath, // = current `node` binary
  ["--experimental-wasm-modules", compiledBenchJS],
  { stdio: ["inherit", "pipe", "pipe"] }
);

child.stdout.pipe(process.stdout);
child.stdout.pipe(fileStream);
child.stderr.pipe(process.stderr);
child.stderr.pipe(fileStream);

child.on("close", (code) => {
  fileStream.end();
  if (code === 0) {
    console.log("✅  Benchmark completed.");
  } else {
    console.error(`❌  Benchmark exited with code ${code}.`);
  }
});
