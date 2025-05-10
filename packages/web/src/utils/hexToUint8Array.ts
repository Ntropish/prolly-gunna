// Helper function to convert a hex string to Uint8Array
const hexToUint8Array = (hexString: string): Uint8Array | null => {
  if (hexString.length === 0) return null;
  if (hexString.length % 2 !== 0) {
    console.warn("Hex string must have an even number of characters");
    return null; // Or throw an error
  }
  const byteArray = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < byteArray.length; i++) {
    byteArray[i] = parseInt(hexString.substr(i * 2, 2), 16);
    if (isNaN(byteArray[i])) {
      console.warn(`Invalid hex character encountered in string: ${hexString}`);
      return null; // Invalid hex
    }
  }
  return byteArray;
};

export default hexToUint8Array;
