import { expect } from "vitest";

// Helper to convert strings to Uint8Array for keys/values
const encoder = new TextEncoder();
export const toU8 = (s: string): Uint8Array => encoder.encode(s);

export function u8ToString(u8: Uint8Array): string {
  return new TextDecoder().decode(u8);
}

// Define DiffEntry type for clarity in tests
export type JsDiffEntry = {
  key: Uint8Array;
  leftValue?: Uint8Array;
  rightValue?: Uint8Array;
};

export const expectU8Eq = (
  a: Uint8Array | undefined | null,
  b: Uint8Array | undefined | null,
  message?: string
) => {
  const context = message ? `: ${message}` : "";
  if (a === undefined || a === null) {
    expect(b, `Expected null${context}`).toBeNull();
    return;
  }
  expect(b, `Expected Uint8Array${context}`).toBeInstanceOf(Uint8Array);
  expect(Array.from(a), `Array comparison${context}`).toEqual(Array.from(b!));
};

// Helper to find a specific hash (as Uint8Array key) in the JS Map from exportChunks
export function findChunkData(
  chunksMap: Map<Uint8Array, Uint8Array>,
  targetHash: Uint8Array | null
): Uint8Array | null {
  if (!targetHash) return null;
  for (const [hashKey, dataValue] of chunksMap.entries()) {
    // Simple byte-by-byte comparison for hash keys
    if (
      hashKey.length === targetHash.length &&
      hashKey.every((byte, i) => byte === targetHash[i])
    ) {
      return dataValue;
    }
  }
  return null; // Hash not found
}

// Helper to format Uint8Array for easier logging reading
export function formatU8Array(arr: Uint8Array | null | undefined): string {
  if (arr === null || arr === undefined) return "null";
  // Convert to hex string for brevity
  return `Uint8Array[${arr.length}](${Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")})`;
}
// Helper to convert a Promise resolving to JsArray of [Uint8Array, Uint8Array] pairs
// back to a simpler array of objects for easier assertion in tests.
export async function jsPromiseToKeyValueArray(
  promise: Promise<any>
): Promise<{ key: Uint8Array; value: Uint8Array }[]> {
  const jsVal = await (promise as any); // Assuming JsFuture.from is used internally or not needed at this layer
  if (!Array.isArray(jsVal)) {
    // Check if it's a JS array directly
    throw new Error("queryItems did not return a JS Array");
  }
  const jsArray = jsVal as any[];
  const results: { key: Uint8Array; value: Uint8Array }[] = [];
  for (let i = 0; i < jsArray.length; i++) {
    const pairJs = jsArray[i];
    if (!Array.isArray(pairJs) || pairJs.length !== 2) {
      throw new Error(`Result at index ${i} is not a [key, value] pair array`);
    }
    const keyJs = pairJs[0];
    const valueJs = pairJs[1];
    if (!(keyJs instanceof Uint8Array) || !(valueJs instanceof Uint8Array)) {
      throw new Error(`Key or value at index ${i} is not a Uint8Array`);
    }
    results.push({ key: keyJs as Uint8Array, value: valueJs as Uint8Array });
  }
  return results;
}

// Helper to compare arrays of key-value pairs
export function expectKeyValueArrayEq(
  actual: { key: Uint8Array; value: Uint8Array }[],
  expected: { key: Uint8Array; value: Uint8Array }[],
  message?: string
) {
  const context = message ? `: ${message}` : "";
  expect(actual.length, `Array length mismatch${context}`).toBe(
    expected.length
  );
  for (let i = 0; i < actual.length; i++) {
    expectU8Eq(
      actual[i].key,
      expected[i].key,
      `Key mismatch at index ${i}${context}`
    );
    expectU8Eq(
      actual[i].value,
      expected[i].value,
      `Value mismatch at index ${i}${context}`
    );
  }
}
