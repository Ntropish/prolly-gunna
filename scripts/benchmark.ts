// benchmark.ts

import { Bench, Task } from "tinybench"; // Import Task for correct typing
import ora from "ora";
import { PTree } from "../dist/node/prolly_rust.js";

const toU8 = (s: string) => new TextEncoder().encode(s);

// A context interface for our benchmarks. Properties are optional
// as not every benchmark will use every property.
interface BenchmarkContext {
  tree?: PTree;
  keys?: Uint8Array[];
  data?: [Uint8Array, Uint8Array][];
  // Allow null for hash properties
  hash1?: Uint8Array | null;
  hash2?: Uint8Array | null;
  rootHash?: Uint8Array | null;
  // Allow null for the chunks map
  chunks?: Map<Uint8Array, Uint8Array> | null;
}

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
    iterations: 10,
  });

  const SMALL_VALUE_SIZE = 100;
  const LARGE_VALUE_SIZE = 32 * 1024;

  // --- BENCHMARK DEFINITIONS ---

  bench
    .add(
      "1,000 individual inserts (small values)",
      async function (this: Task & BenchmarkContext) {
        const tree = new PTree();
        for (const [key, val] of this.data!) {
          await tree.insert(key, val);
        }
      },
      {
        beforeAll(this: Task & BenchmarkContext) {
          this.data = generateData(1000, "insert_small", () =>
            createLargeValue(SMALL_VALUE_SIZE)
          );
        },
      }
    )
    .add(
      "1,000 individual inserts (large values, with CDC)",
      async function (this: Task & BenchmarkContext) {
        const tree = new PTree();
        for (const [key, val] of this.data!) {
          await tree.insert(key, val);
        }
      },
      {
        beforeAll(this: Task & BenchmarkContext) {
          this.data = generateData(1000, "insert_large", () =>
            createLargeValue(LARGE_VALUE_SIZE)
          );
        },
      }
    )
    .add(
      "10,000 items batch insert (small values)",
      async function (this: Task & BenchmarkContext) {
        const tree = new PTree();
        await tree.insertBatch(this.data! as any);
      },
      {
        beforeAll(this: Task & BenchmarkContext) {
          this.data = generateData(10000, "batch_small", () =>
            createLargeValue(SMALL_VALUE_SIZE)
          );
        },
      }
    )
    .add(
      "1,000 items batch insert (large values, with CDC)",
      async function (this: Task & BenchmarkContext) {
        const tree = new PTree();
        await tree.insertBatch(this.data! as any);
      },
      {
        beforeAll(this: Task & BenchmarkContext) {
          this.data = generateData(1000, "batch_large", () =>
            createLargeValue(LARGE_VALUE_SIZE)
          );
        },
      }
    )
    .add(
      "10,000 individual gets (small values)",
      async function (this: Task & BenchmarkContext) {
        for (const key of this.keys!) {
          await this.tree!.get(key);
        }
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(10000, "get_small", () =>
            createLargeValue(SMALL_VALUE_SIZE)
          );
          await this.tree.insertBatch(data as any);
          this.keys = data
            .map((item) => item[0])
            .sort(() => Math.random() - 0.5);
        },
      }
    )
    .add(
      "1,000 individual gets (large values, with CDC)",
      async function (this: Task & BenchmarkContext) {
        for (const key of this.keys!) {
          await this.tree!.get(key);
        }
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(1000, "get_large", () =>
            createLargeValue(LARGE_VALUE_SIZE)
          );
          await this.tree.insertBatch(data as any);
          this.keys = data
            .map((item) => item[0])
            .sort(() => Math.random() - 0.5);
        },
      }
    )
    .add(
      "1,000 individual deletes",
      async function (this: Task & BenchmarkContext) {
        for (const key of this.keys!) {
          await this.tree!.delete(key);
        }
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(1000, "delete", () =>
            createLargeValue(SMALL_VALUE_SIZE)
          );
          await this.tree.insertBatch(data as any);
          this.keys = data
            .map((item) => item[0])
            .sort(() => Math.random() - 0.5);
        },
      }
    )
    .add(
      "Diff with 1 modification in 5000 items",
      async function (this: Task & BenchmarkContext) {
        await this.tree!.diffRoots(this.hash1!, this.hash2!);
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(5000, "diff_small", () =>
            createLargeValue(100)
          );
          await this.tree.insertBatch(data as any);
          this.hash1 = await this.tree.getRootHash();
          await this.tree.insert(toU8("diff_small_00001"), toU8("new_value"));
          this.hash2 = await this.tree.getRootHash();
        },
      }
    )
    .add(
      "Diff with 10% modifications in 5000 items",
      async function (this: Task & BenchmarkContext) {
        await this.tree!.diffRoots(this.hash1!, this.hash2!);
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const count = 5000;
          const data = generateData(count, "diff_large_change", () =>
            createLargeValue(100)
          );
          await this.tree.insertBatch(data as any);
          this.hash1 = await this.tree.getRootHash();
          for (let i = 0; i < count / 10; i++) {
            const key = toU8(`diff_large_change_${String(i).padStart(5, "0")}`);
            await this.tree.insert(key, toU8(`new_value_${i}`));
          }
          this.hash2 = await this.tree.getRootHash();
        },
      }
    )
    .add(
      "Full iteration over 10000 items",
      async function (this: Task & BenchmarkContext) {
        const cursor = await this.tree!.cursorStart();
        while (true) {
          if ((await cursor.next()).done) break;
        }
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(10000, "iter", () => createLargeValue(100));
          await this.tree.insertBatch(data as any);
        },
      }
    )
    .add(
      "Exporting 10000 items with 512-byte values",
      async function (this: Task & BenchmarkContext) {
        await this.tree!.exportChunks();
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          this.tree = new PTree();
          const data = generateData(10000, "export", () =>
            createLargeValue(512)
          );
          await this.tree.insertBatch(data as any);
        },
      }
    )
    .add(
      "Loading 3000 items with 512-byte values",
      async function (this: Task & BenchmarkContext) {
        await PTree.load(this.rootHash!, this.chunks!);
      },
      {
        async beforeAll(this: Task & BenchmarkContext) {
          const tree1 = new PTree();
          const data = generateData(3000, "load", () => createLargeValue(512));
          await tree1.insertBatch(data as any);
          this.rootHash = await tree1.getRootHash();
          this.chunks = await tree1.exportChunks();
        },
      }
    );

  // --- Progress Indicator & Runner (code is unchanged) ---
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

  await bench.run();

  console.log("\n--- Performance Benchmark Results ---");
  console.table(bench.table());

  spinner.start("💾 Running storage footprint benchmark...");
  const storageReport = await runStorageFootprintBenchmark();
  spinner.succeed("💾 Storage footprint benchmark complete.");
  console.log(storageReport.join("\n"));

  console.log("\n✅ All benchmarks complete.");
}

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

main().catch((e) => {
  console.error(e);
});
