// prolly-rust/src/store/mem_store.rs

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc; // Using Arc for shared ownership with RwLock
use tokio::sync::RwLock;

use crate::common::Hash;
use crate::error::{Result, ProllyError};
use crate::chunk::hash_bytes; // Assuming hash_bytes will be available from crate::chunk
use super::chunk_store::ChunkStore;

#[derive(Debug, Default)]
pub struct InMemoryStoreInner {
    data: HashMap<Hash, Vec<u8>>,
}

/// An in-memory `ChunkStore` implementation using `tokio::sync::RwLock`.
#[derive(Debug, Clone, Default)]
pub struct InMemoryStore {
    inner: Arc<RwLock<InMemoryStoreInner>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    // Optional: A way to construct from an existing HashMap, perhaps for testing or loading.
    // This would need to be async if it involves complex setup or use async locks internally.
    // For simplicity, we'll stick to `new()` for now.
    // pub async fn from_map(map: HashMap<Hash, Vec<u8>>) -> Self {
    //     Self {
    //         inner: Arc::new(RwLock::new(InMemoryStoreInner { data: map })),
    //     }
    // }

    /// Helper for tests or specific scenarios to get all chunks (non-async for direct access if needed by caller)
    /// Note: This bypasses the async trait methods for direct inspection.
    pub async fn get_all_chunks_for_test(&self) -> HashMap<Hash, Vec<u8>> {
        self.inner.read().await.data.clone()
    }
}

#[async_trait]
impl ChunkStore for InMemoryStore {
    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>> {
        let guard = self.inner.read().await;
        Ok(guard.data.get(hash).cloned())
    }

    async fn put(&self, bytes: Vec<u8>) -> Result<Hash> {
        // It's important that the hash is calculated *before* acquiring the write lock
        // if the hash calculation is expensive, though blake3 is very fast.
        // For consistency, the store should define how hashes are made.
        let hash = hash_bytes(&bytes); // Using hash_bytes from crate::chunk

        let mut guard = self.inner.write().await;
        // Using entry API to avoid cloning bytes if already present,
        // though current ChunkStore::put implies overwriting or assuming content-addressing handles duplicates.
        // For content-addressable storage, if hash exists, data must be identical.
        guard.data.entry(hash).or_insert_with(|| bytes);
        Ok(hash)
    }

    async fn exists(&self, hash: &Hash) -> Result<bool> {
        let guard = self.inner.read().await;
        Ok(guard.data.contains_key(hash))
    }

    async fn delete_batch(&self, hashes: &[Hash]) -> Result<()> {
        if hashes.is_empty() {
            return Ok(());
        }
        let mut guard = self.inner.write().await;
        for hash in hashes {
            guard.data.remove(hash);
        }
        Ok(())
    }

    async fn all_hashes(&self) -> Result<Vec<Hash>> {
        let guard = self.inner.read().await;
        // Collect all keys (hashes) from the HashMap
        let hashes_vec = guard.data.keys().cloned().collect();
        Ok(hashes_vec)
    }

    fn get_sync(&self, hash: &Hash) -> Result<Option<Vec<u8>>> {
        let guard = self.inner.try_read().map_err(|_| {
            ProllyError::StorageError("Failed to acquire synchronous read lock on store. An async write operation is likely in progress.".to_string())
        })?;
        Ok(guard.data.get(hash).cloned())
    }
}

// Wasm-specific helpers (like your original `from_js_map`) would go here if needed.
// They would need to be adapted to the async nature or work with a temporary sync HashMap.
// For now, let's keep the core store async and Wasm bindings can adapt later if necessary.
// For example, if `from_js_map` must be sync due to Wasm constraints, it could
// create a temporary sync HashMap and then construct InMemoryStore from that.
// Wasm-specific helpers 
#[cfg(target_arch = "wasm32")]
mod wasm_specific {
    use super::*;
    use js_sys::{Map as JsMap, Uint8Array as JsUint8Array, Array as JsArray};
    use wasm_bindgen::{JsCast, JsValue};

    impl InMemoryStore {
        /// Convert a JS `Map<Uint8Array, Uint8Array>` ➜ Rust HashMap, then to InMemoryStore.
        /// This function itself is synchronous as it processes JS objects directly.
        /// The resulting InMemoryStore is async.
        pub fn from_js_map(map: &JsMap) -> std::result::Result<Self, JsValue> { // Returns std::result for JsValue
            let mut inner_map = HashMap::new();
            let entries = js_sys::try_iter(map)
                .map_err(|_| JsValue::from_str("Input Map is not iterable"))?
                .ok_or_else(|| JsValue::from_str("Failed to create iterator from Map"))?;

            for entry_result in entries {
                let entry = entry_result.map_err(|e| e)?;
                let pair_array = entry
                    .dyn_into::<JsArray>()
                    .map_err(|_| JsValue::from_str("Map entry is not an array"))?;

                if pair_array.length() != 2 {
                    return Err(JsValue::from_str("Map entry array must have 2 elements (key, value)"));
                }

                let key_js = pair_array.get(0);
                let val_js = pair_array.get(1);

                let key_u8array = key_js
                    .dyn_into::<JsUint8Array>()
                    .map_err(|_| JsValue::from_str("Map key is not a Uint8Array"))?;
                let val_u8array = val_js
                    .dyn_into::<JsUint8Array>()
                    .map_err(|_| JsValue::from_str("Map value is not a Uint8Array"))?;

                if key_u8array.length() != 32 {
                    return Err(JsValue::from_str("Hash key must be 32 bytes long"));
                }
                let mut h: Hash = [0u8; 32];
                key_u8array.copy_to(&mut h);
                inner_map.insert(h, val_u8array.to_vec());
            }

            Ok(Self {
                inner: Arc::new(RwLock::new(InMemoryStoreInner { data: inner_map })),
            })
        }
    }
}