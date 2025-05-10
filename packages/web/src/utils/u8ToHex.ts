const u8ToHex = (u8: Uint8Array | null | undefined): string => {
  if (!u8) return "null";
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export default u8ToHex;
