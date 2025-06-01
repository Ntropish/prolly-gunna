// src/lib/prollyUtils.ts

import { uniqueNameGenerator } from "unique-name-generator";
export const FILE_SIGNATURE = "PRLYTRE1"; // 8 bytes
export const FILE_VERSION = 0x01; // 1 byte

// Metadata Block Tag
export const TAG_METADATA = 0x01;
// Chunk Block Tag
export const TAG_CHUNK = 0x10;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Converts a string to a Uint8Array using UTF-8 encoding.
 * @param s The string to convert.
 * @returns The Uint8Array representation of the string.
 */
export const toU8 = (s: string): Uint8Array => textEncoder.encode(s);

/**
 * Converts a Uint8Array to a string using UTF-8 decoding.
 * Returns an empty string if the input is null or undefined.
 * @param u8 The Uint8Array to convert.
 * @returns The string representation or an empty string.
 */
export const u8ToString = (u8: Uint8Array | null | undefined): string => {
  if (u8 === null || u8 === undefined) return "";
  return textDecoder.decode(u8);
};

/**
 * Converts a Uint8Array to its hexadecimal string representation.
 * Returns an empty string if the input is null or undefined.
 * @param u8 The Uint8Array to convert.
 * @returns The hex string or an empty string.
 */
export const u8ToHex = (u8: Uint8Array | null | undefined): string => {
  if (!u8) return "";
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Converts a hexadecimal string to a Uint8Array.
 * Returns null if the hex string is empty, has an odd length, or contains invalid characters.
 * @param hexString The hexadecimal string to convert.
 * @returns The Uint8Array or null if conversion fails.
 */
export const hexToU8 = (hexString: string): Uint8Array | null => {
  const cleanHexString = hexString.startsWith("0x")
    ? hexString.substring(2)
    : hexString;
  if (cleanHexString.length === 0) return null;
  if (cleanHexString.length % 2 !== 0) {
    console.warn(
      "Hex string must have an even number of characters for conversion."
    );
    return null;
  }
  const byteArray = new Uint8Array(cleanHexString.length / 2);
  for (let i = 0; i < byteArray.length; i++) {
    const byte = parseInt(cleanHexString.substr(i * 2, 2), 16);
    if (isNaN(byte)) {
      console.warn(
        `Invalid hex character encountered in string: "${cleanHexString}" at position ${
          i * 2
        }`
      );
      return null;
    }
    byteArray[i] = byte;
  }
  return byteArray;
};

/**
 * Triggers a browser download for the given data.
 * @param data The data to download (ArrayBuffer or Blob).
 * @param filename The desired filename for the download.
 * @param mimeType The MIME type of the data.
 */
export const triggerBrowserDownload = (
  data: ArrayBuffer | Blob,
  filename: string,
  mimeType: string = "application/octet-stream"
): void => {
  const blob =
    data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
};
