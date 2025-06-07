// benchmark.ts

import { Bench } from "tinybench";
import ora from "ora"; // Import the new dependency
import { PTree } from "../dist/prolly_rust.js";

const toU8 = (s: string) => new TextEncoder().encode(s);

// --- Helper Functions (remain the same) ---
function generateData(
  count: number,
  keyPrefix: string,
  valueGenerator: (i: number) => Uint8Array
): [Uint8Array, Uint8Array][] {
  const data: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < count; i++) {
    const key = toU8(`${keyPrefix}_${String(i).padStart(5, "0")}`);
    const value = valueGenerator(i);
    data.push([key, value]);
  }
  return data;
}

function createLargeValue(size: number, seed: number = 42): Uint8Array {
  const buffer = new Uint8Array(size);
  let current = seed;
  for (let i = 0; i < size; i++) {
    current = (current * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = current % 256;
  }
  return buffer;
}

// --- Main Benchmark Orchestration ---
async function main() {
  console.log("🚀 Preparing PTree benchmark suite...");

  const bench = new Bench({
    warmupIterations: 2,
    iterations: 5,
  });

  const SMALL_VALUE_SIZE = 100;
  const LARGE_VALUE_SIZE = 32 * 1024;

  bench
    // --- INSERTION BENCHMARKS ---
    .add("1,000 individual inserts (small values)", async () => {
      const tree = new PTree();
      const data = generateData(1000, "insert_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      for (const [key, val] of data) {
        await tree.insert(key, val);
      }
    })
    .add("1,000 individual inserts (large values, with CDC)", async () => {
      const tree = new PTree();
      const data = generateData(1000, "insert_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );
      for (const [key, val] of data) {
        await tree.insert(key, val);
      }
    })

    // --- BATCH INSERTION BENCHMARKS ---
    .add("10,000 items batch insert (small values)", async () => {
      const tree = new PTree();
      const data = generateData(10000, "batch_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);
    })
    .add("1,000 items batch insert (large values, with CDC)", async () => {
      const tree = new PTree();
      const data = generateData(1000, "batch_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);
    })

    // --- GET (READ) BENCHMARKS ---
    .add("10,000 individual gets (small values)", async () => {
      const tree = new PTree();
      const data = generateData(10000, "get_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);
      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);
      for (const key of shuffledKeys) {
        await tree.get(key);
      }
    })
    .add("1,000 individual gets (large values, with CDC)", async () => {
      const tree = new PTree();
      const data = generateData(1000, "get_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);
      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);
      for (const key of shuffledKeys) {
        await tree.get(key);
      }
    })

    // --- DELETION BENCHMARKS ---
    .add("1,000 individual deletes", async () => {
      const tree = new PTree();
      const data = generateData(1000, "delete", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);
      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);
      for (const key of shuffledKeys) {
        await tree.delete(key);
      }
    })

    // --- ADVANCED: DIFF BENCHMARKS ---
    .add("Diff with 1 modification in 5000 items", async () => {
      const tree = new PTree();
      const count = 5000;
      const data = generateData(count, "diff_small", () =>
        createLargeValue(100)
      );
      await tree.insertBatch(data as any);
      const hash1 = await tree.getRootHash();
      await tree.insert(toU8("diff_small_00001"), toU8("new_value"));
      const hash2 = await tree.getRootHash();
      await tree.diffRoots(hash1, hash2);
    })
    .add("Diff with 10% modifications in 5000 items", async () => {
      const tree = new PTree();
      const count = 5000;
      const data = generateData(count, "diff_large_change", () =>
        createLargeValue(100)
      );
      await tree.insertBatch(data as any);
      const hash1 = await tree.getRootHash();
      for (let i = 0; i < count / 10; i++) {
        const key = toU8(`diff_large_change_${String(i).padStart(5, "0")}`);
        await tree.insert(key, toU8(`new_value_${i}`));
      }
      const hash2 = await tree.getRootHash();
      await tree.diffRoots(hash1, hash2);
    })

    // --- ADVANCED: ITERATION BENCHMARKS ---
    .add("Full iteration over 10000 items", async () => {
      const tree = new PTree();
      const data = generateData(10000, "iter", () => createLargeValue(100));
      await tree.insertBatch(data as any);
      const cursor = await tree.cursorStart();
      while (true) {
        const res = await cursor.next();
        if (res.done) break;
      }
    })

    // --- ADVANCED: PERSISTENCE BENCHMARKS ---
    .add("Exporting 10000 items with 512-byte values", async () => {
      const tree = new PTree();
      const data = generateData(10000, "export", () => createLargeValue(512));
      await tree.insertBatch(data as any);
      await tree.exportChunks();
    })
    .add("Loading 3000 items with 512-byte values", async () => {
      const tree1 = new PTree();
      const data = generateData(3000, "load", () => createLargeValue(512));
      await tree1.insertBatch(data as any);
      const rootHash = await tree1.getRootHash();
      const chunks = await tree1.exportChunks();
      await PTree.load(rootHash, chunks);
    });
  // --- Progress Indicator Setup ---
  const spinner = ora({ spinner: "dots", color: "yellow" });
  const totalBenchmarks = bench.tasks.length;
  let currentTaskIndex = 0;

  bench.addEventListener("start", () => {
    const task = bench.tasks[currentTaskIndex];
    if (task) {
      spinner.start(
        `[${currentTaskIndex + 1}/${totalBenchmarks}] Running: ${task.name}`
      );
    }
  });

  bench.addEventListener("cycle", (event) => {
    const task = event.task;
    spinner.succeed(
      `[${currentTaskIndex + 1}/${totalBenchmarks}] Finished: ${task?.name}`
    );
    currentTaskIndex++;
    const nextTask = bench.tasks[currentTaskIndex];
    if (nextTask) {
      spinner.start(
        `[${currentTaskIndex + 1}/${totalBenchmarks}] Running: ${nextTask.name}`
      );
    }
  });

  bench.addEventListener("error", (event) => {
    spinner.fail(
      `[${currentTaskIndex + 1}/${totalBenchmarks}] Failed: ${event.task?.name}`
    );
  });

  // --- Run Benchmarks ---
  await bench.run();

  console.log("\n--- Performance Benchmark Results ---");
  console.table(bench.table());

  spinner.start("💾 Running storage footprint benchmark...");
  const storageReport = await runStorageFootprintBenchmark();
  spinner.succeed("💾 Storage footprint benchmark complete.");
  console.log(storageReport.join("\n"));

  console.log("\n✅ All benchmarks complete.");
}

// Modified to return its output instead of logging directly
async function runStorageFootprintBenchmark(): Promise<string[]> {
  const output: string[] = [];
  const tree = new PTree();
  const count = 3000;
  const data = generateData(count, "sharing", () => createLargeValue(1024));
  await tree.insertBatch(data as any);
  const chunks1 = await tree.exportChunks();
  const size1 = Array.from(chunks1.values()).reduce(
    (acc, val) => acc + val.length,
    0
  );
  output.push(
    `[INFO] Size of initial tree with ${count} items: ${(
      size1 /
      1024 /
      1024
    ).toFixed(2)} MB`
  );
  await tree.insert(toU8("sharing_00001"), toU8("a new value that is small"));
  const chunks2 = await tree.exportChunks();
  const size2 = Array.from(chunks2.values()).reduce(
    (acc, val) => acc + val.length,
    0
  );
  output.push(
    `[INFO] Size of tree after 1 modification: ${(size2 / 1024 / 1024).toFixed(
      2
    )} MB`
  );
  const addedSize = size2 - size1;
  output.push(
    `[RESULT] Incremental storage cost for 1 modification: ${(
      addedSize / 1024
    ).toFixed(2)} KB`
  );
  return output;
}

// --- SCRIPT EXECUTION ---
// Note: To keep the code above clean, I've omitted the full benchmark definitions.
// You should only need to add the `ora` logic to your existing, complete file.
// The omitted parts are marked with /* ... */
main().catch((e) => {
  console.error(e);
});
