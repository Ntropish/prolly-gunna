// prolly-rust/src/store/mem_store.rs

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use js_sys::{Map as JsMap, Uint8Array as JsUint8Array, Array as JsArray};
use wasm_bindgen::{JsCast, JsValue};


use crate::common::Hash;
use crate::error::Result;
use crate::chunk::hash_bytes;
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

    pub async fn get_all_chunks_for_test(&self) -> HashMap<Hash, Vec<u8>> {
        self.inner.read().await.data.clone()
    }

    /// Convert a JS `Map<Uint8Array, Uint8Array>` ➜ Rust HashMap, then to InMemoryStore.
    /// This function itself is synchronous as it processes JS objects directly.
    /// The resulting InMemoryStore is async.
    #[cfg(target_arch = "wasm32")]
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

// MAKE THIS IMPL MATCH THE TRAIT DEFINITION
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ChunkStore for InMemoryStore {
    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>> {
        let guard = self.inner.read().await;
        Ok(guard.data.get(hash).cloned())
    }

    async fn put(&self, bytes: Vec<u8>) -> Result<Hash> {
        let hash = hash_bytes(&bytes);

        let mut guard = self.inner.write().await;
        guard.data.entry(hash).or_insert_with(|| bytes);
        Ok(hash)
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
        let hashes_vec = guard.data.keys().cloned().collect();
        Ok(hashes_vec)
    }
}