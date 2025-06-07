// const { spawn } = require("child_process");
// const fs = require("fs");
// const path = require("path");

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

// --- Configuration ---
const benchmarksDir = path.join(__dirname, "..", "benchmarks");
const benchmarkCommand = "ts-node";
const benchmarkArgs = [path.join(__dirname, "benchmark.ts")];

// --- Script Logic ---

// 1. Create the 'benchmarks' directory if it doesn't exist.
fs.mkdirSync(benchmarksDir, { recursive: true });

// 2. Generate a Windows-safe ISO8601 timestamp for the filename.
//    (Replaces colons, which are invalid in Windows filenames).
const timestamp = new Date().toISOString().replace(/:/g, "-");
const outputFilePath = path.join(benchmarksDir, `${timestamp}.txt`);

console.log(`🚀 Starting benchmark...`);
console.log(`📝 Saving output to: ${outputFilePath}\n`);

// 3. Create a write stream to the output file.
const fileStream = fs.createWriteStream(outputFilePath);

// 4. Spawn the benchmark process.
//    Using `shell: true` ensures `ts-node` can be found in `node_modules/.bin`.
const child = spawn(benchmarkCommand, benchmarkArgs, {
  shell: true,
  stdio: "pipe", // We will manually pipe stdout/stderr.
});

// 5. Pipe the child's stdout to both the console and the file stream.
child.stdout.pipe(process.stdout);
child.stdout.pipe(fileStream);

// 6. Pipe the child's stderr to both the console and the file stream.
child.stderr.pipe(process.stderr);
child.stderr.pipe(fileStream);

// 7. Handle the process exit.
child.on("close", (code: number) => {
  if (code === 0) {
    console.log(`\n✅ Benchmark output saved successfully.`);
  } else {
    console.error(`\n❌ Benchmark script exited with code ${code}.`);
  }
  // Close the file stream.
  fileStream.end();
});

child.on("error", (err: Error) => {
  console.error("❌ Failed to start benchmark script:", err);
  fileStream.end();
});
