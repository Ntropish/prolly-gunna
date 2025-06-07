import { describe, it, beforeAll } from "vitest";
import { WasmProllyTree } from "../dist/prolly_rust.js";
import { toU8 } from "./lib/utils";

// Helper to generate deterministic key-value pairs
function generateData(
  count: number,
  keyPrefix: string,
  valueGenerator: (i: number) => Uint8Array
) {
  const data: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < count; i++) {
    const key = toU8(`${keyPrefix}_${String(i).padStart(5, "0")}`);
    const value = valueGenerator(i);
    data.push([key, value]);
  }
  return data;
}

// Helper for creating pseudo-random large values
function createLargeValue(size: number, seed: number = 42): Uint8Array {
  const buffer = new Uint8Array(size);
  let current = seed;
  for (let i = 0; i < size; i++) {
    current = (current * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = current % 256;
  }
  return buffer;
}

// Simple benchmarking runner
async function runBenchmark(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  await fn();
  const end = performance.now();
  const duration = end - start;
  console.log(`[BENCH] ${name}: ${duration.toFixed(4)} ms`);
  return duration;
}

beforeAll(async () => {
  // Make sure the WASM module is initialized
  // await init();
});

describe("WasmProllyTree Benchmarks", () => {
  const SMALL_VALUE_SIZE = 100; // 100 bytes
  const LARGE_VALUE_SIZE = 32 * 1024; // 32 KB, likely to trigger CDC
  const BENCHMARK_TIMEOUT = 60000; // 60 seconds for each benchmark

  // --- INSERTION BENCHMARKS ---

  it(
    "Benchmark: 1,000 individual inserts (small values)",
    async () => {
      const tree = new WasmProllyTree();
      const data = generateData(1000, "insert_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );

      await runBenchmark(
        "1,000 individual inserts (small values)",
        async () => {
          for (const [key, val] of data) {
            await tree.insert(key, val);
          }
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: 1,000 individual inserts (large values)",
    async () => {
      const tree = new WasmProllyTree();
      const data = generateData(1000, "insert_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );

      await runBenchmark(
        "1,000 individual inserts (large values, with CDC)",
        async () => {
          for (const [key, val] of data) {
            await tree.insert(key, val);
          }
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  // --- BATCH INSERTION BENCHMARKS ---

  it(
    "Benchmark: 10,000 items via insertBatch (small values)",
    async () => {
      const tree = new WasmProllyTree();
      const data = generateData(10000, "batch_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );

      await runBenchmark(
        "10,000 items batch insert (small values)",
        async () => {
          await tree.insertBatch(data as any);
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: 1,000 items via insertBatch (large values)",
    async () => {
      const tree = new WasmProllyTree();
      const data = generateData(1000, "batch_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );

      await runBenchmark(
        "1,000 items batch insert (large values, with CDC)",
        async () => {
          await tree.insertBatch(data as any);
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  // --- GET (READ) BENCHMARKS ---

  it(
    "Benchmark: 10,000 individual gets (small values)",
    async () => {
      const tree = new WasmProllyTree();
      const count = 10000;
      const data = generateData(count, "get_small", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);

      // Get keys in random order to prevent cache pre-fetching effects
      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);

      await runBenchmark("10,000 individual gets (small values)", async () => {
        for (const key of shuffledKeys) {
          await tree.get(key);
        }
      });
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: 1,000 individual gets (large values)",
    async () => {
      const tree = new WasmProllyTree();
      const count = 1000;
      const data = generateData(count, "get_large", () =>
        createLargeValue(LARGE_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);

      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);

      await runBenchmark(
        "1,000 individual gets (large values, with CDC)",
        async () => {
          for (const key of shuffledKeys) {
            await tree.get(key);
          }
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  // --- DELETION BENCHMARKS ---

  it(
    "Benchmark: 1,000 individual deletes",
    async () => {
      const tree = new WasmProllyTree();
      const count = 1000;
      const data = generateData(count, "delete", () =>
        createLargeValue(SMALL_VALUE_SIZE)
      );
      await tree.insertBatch(data as any);

      // Delete keys in random order to trigger varied rebalancing/merging
      const shuffledKeys = data
        .map((item) => item[0])
        .sort(() => Math.random() - 0.5);

      await runBenchmark("1,000 individual deletes", async () => {
        for (const key of shuffledKeys) {
          await tree.delete(key);
        }
      });
    },
    BENCHMARK_TIMEOUT
  );
});

describe("WasmProllyTree Advanced Benchmarks", () => {
  const BENCHMARK_TIMEOUT = 100000; // 100 seconds

  it(
    "Benchmark: Diff performance (small change)",
    async () => {
      const tree = new WasmProllyTree();
      const count = 5000;
      const data = generateData(count, "diff_small_change", () =>
        createLargeValue(100)
      );
      await tree.insertBatch(data as any);
      const hash1 = await tree.getRootHash();

      // Introduce a small change
      await tree.insert(toU8("diff_small_change_00001"), toU8("new_value"));
      const hash2 = await tree.getRootHash();

      await runBenchmark(
        `Diff with 1 modification in ${count} items`,
        async () => {
          await tree.diffRoots(hash1, hash2);
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: Diff performance (10% change)",
    async () => {
      const tree = new WasmProllyTree();
      const count = 5000;
      const data = generateData(count, "diff_large_change", () =>
        createLargeValue(100)
      );
      await tree.insertBatch(data as any);
      const hash1 = await tree.getRootHash();

      // Modify 10% of the items
      for (let i = 0; i < count / 10; i++) {
        const key = toU8(`diff_large_change_${String(i).padStart(5, "0")}`);
        await tree.insert(key, toU8(`new_value_${i}`));
      }
      const hash2 = await tree.getRootHash();

      await runBenchmark(
        `Diff with 10% modifications in ${count} items`,
        async () => {
          await tree.diffRoots(hash1, hash2);
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  // --- ITERATION / CURSOR BENCHMARKS ---

  it(
    "Benchmark: Full iteration with cursor over 10,000 items",
    async () => {
      const tree = new WasmProllyTree();
      const count = 10000;
      const data = generateData(count, "iter", () => createLargeValue(100));
      await tree.insertBatch(data as any);

      await runBenchmark(`Full iteration over ${count} items`, async () => {
        const cursor = await tree.cursorStart();
        while (true) {
          const result = await cursor.next();
          if (result.done) break;
        }
      });
    },
    BENCHMARK_TIMEOUT
  );

  // --- STRUCTURAL SHARING & PERSISTENCE BENCHMARKS ---

  it(
    "Benchmark: Export performance of a large tree",
    async () => {
      const tree = new WasmProllyTree();
      const count = 10000;
      const data = generateData(count, "export", () => createLargeValue(512));
      await tree.insertBatch(data as any);

      await runBenchmark(
        `Exporting ${count} items with 512-byte values`,
        async () => {
          await tree.exportChunks();
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: Load performance of a large tree",
    async () => {
      const tree1 = new WasmProllyTree();
      const count = 10000;
      const data = generateData(count, "load", () => createLargeValue(512));
      await tree1.insertBatch(data as any);
      const rootHash = await tree1.getRootHash();
      const chunks = await tree1.exportChunks();

      await runBenchmark(
        `Loading ${count} items with 512-byte values`,
        async () => {
          await WasmProllyTree.load(rootHash, chunks);
        }
      );
    },
    BENCHMARK_TIMEOUT
  );

  it(
    "Benchmark: Structural Sharing Footprint (a proxy for memory/storage savings)",
    async () => {
      const tree = new WasmProllyTree();
      const count = 3000;
      const data = generateData(count, "sharing", () => createLargeValue(1024));
      await tree.insertBatch(data as any);

      // Export the initial state
      const chunks1 = await tree.exportChunks();
      const size1 = Array.from(chunks1.values()).reduce(
        (acc, val) => acc + val.length,
        0
      );
      console.log(
        `[INFO] Size of initial tree with ${count} items: ${(
          size1 /
          1024 /
          1024
        ).toFixed(2)} MB`
      );

      // Make one small modification
      await tree.insert(
        toU8("sharing_00001"),
        toU8("a new value that is small")
      );

      // Export the new state
      const chunks2 = await tree.exportChunks();
      const size2 = Array.from(chunks2.values()).reduce(
        (acc, val) => acc + val.length,
        0
      );
      console.log(
        `[INFO] Size of tree after 1 modification: ${(
          size2 /
          1024 /
          1024
        ).toFixed(2)} MB`
      );

      const addedSize = size2 - size1;
      console.log(
        `[BENCH] Incremental storage cost for 1 modification in ${count} items: ${(
          addedSize / 1024
        ).toFixed(2)} KB`
      );
    },
    BENCHMARK_TIMEOUT
  );
});
