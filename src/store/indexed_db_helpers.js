// src/store/indexed_db_helpers.js
const DB_VERSION = 1;
const STORE_NAME = "chunks";

// Helper to promisify an IDBRequest
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openDb(dbName) {
  const request = indexedDB.open(dbName, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME); // Key will be the hash (Uint8Array)
    }
  };
  return req(request);
}

export async function getChunk(db, key) {
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  return await req(store.get(key)); // Returns Uint8Array or undefined
}

export async function putChunk(db, key, value) {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await req(store.put(value, key));
  return tx.done; // Promise that resolves when transaction completes
}

export async function deleteChunks(db, keys) {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const promises = keys.map((key) => req(store.delete(key)));
  await Promise.all(promises);
  return tx.done;
}

export async function getAllKeys(db) {
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  return await req(store.getAllKeys()); // Returns an array of Uint8Array keys
}
