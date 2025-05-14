export const getPrefixScanEndBound = (
  prefixU8: Uint8Array
): Uint8Array | undefined => {
  if (prefixU8.length === 0) return undefined; // Scan all if prefix is empty

  const endBound = new Uint8Array(prefixU8);
  for (let i = endBound.length - 1; i >= 0; i--) {
    if (endBound[i] < 255) {
      endBound[i]++;
      return endBound.slice(0, i + 1);
    }
  }
  // If all bytes are 255 (e.g., prefix is [255, 255]), it's hard to make a *shorter* or same-length successor.
  // In this specific case, for an *exclusive* end bound, not setting an end bound
  // means "scan everything from this prefix onwards".
  // Or, to truly make an exclusive bound just after this prefix, we could append a 0 byte,
  // making it longer and thus greater: [255, 255, 0].
  // However, this depends on whether the Prolly Tree keys can contain null bytes meaningfully.
  // For most string-like prefixes, the loop above will find a successor.
  // If the loop finishes, the prefix was all 255s.
  // For an exclusive end bound, perhaps we don't set one, or use a special marker if the DB supports it.
  // Given the current scan logic, not setting an endBound means "to the end of the tree".
  // This is acceptable for "all keys starting with [255, 255, ...]".
  return undefined;
};
