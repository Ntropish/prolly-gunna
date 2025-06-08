// src/store/indexed_db_store.rs

use crate::common::{Hash, Value};
use crate::error::{ProllyError, Result};
use crate::store::ChunkStore;
use async_trait::async_trait;
use js_sys::{Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen(module = "/src/store/indexed_db_helpers.js")]
extern "C" {
    #[wasm_bindgen(catch)]
    async fn openDb(db_name: &str) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn getChunk(db: &JsValue, key: &JsValue) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn putChunk(db: &JsValue, key: &JsValue, value: &JsValue) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn deleteChunks(db: &JsValue, keys: &js_sys::Array) -> std::result::Result<JsValue, JsValue>;

    #[wasm_bindgen(catch)]
    async fn getAllKeys(db: &JsValue) -> std::result::Result<JsValue, JsValue>;
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct IndexedDBStore {
    db_conn: JsValue,
    name: String,
}

#[wasm_bindgen]
impl IndexedDBStore {
    #[wasm_bindgen(constructor)]
    pub async fn new(db_name: &str) -> std::result::Result<IndexedDBStore, JsValue> {
        let db_conn = openDb(db_name).await?;
        Ok(Self {
            db_conn,
            name: db_name.to_string(),
        })
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }
}

#[async_trait(?Send)]
impl ChunkStore for IndexedDBStore {
    async fn get(&self, hash: &Hash) -> Result<Option<Value>> {
        let key = Uint8Array::from(&hash[..]);
        let promise = getChunk(&self.db_conn, &key.into()).await.map_err(|e| ProllyError::StorageError(format!("IDB get failed: {:?}", e)))?;
        let result_js = wasm_bindgen_futures::JsFuture::from(Promise::from(promise)).await.map_err(|e| ProllyError::StorageError(format!("IDB get failed: {:?}", e)))?;

        if result_js.is_undefined() {
            Ok(None)
        } else {
            Ok(Some(result_js.dyn_into::<Uint8Array>().unwrap().to_vec()))
        }
    }

    async fn put(&self, bytes: Value) -> Result<Hash> {
        let hash = crate::chunk::hash_bytes(&bytes);
        let key = Uint8Array::from(&hash[..]);
        let value = Uint8Array::from(&bytes[..]);
        
        let promise = putChunk(&self.db_conn, &key.into(), &value.into()).await.map_err(|e| ProllyError::StorageError(format!("IDB put failed: {:?}", e)))?;
        wasm_bindgen_futures::JsFuture::from(Promise::from(promise)).await.map_err(|e| ProllyError::StorageError(format!("IDB put failed: {:?}", e)))?;
        
        Ok(hash)
    }

    async fn delete_batch(&self, hashes: &[Hash]) -> Result<()> {
        let keys_array = js_sys::Array::new();
        for hash in hashes {
            keys_array.push(&Uint8Array::from(&hash[..]).into());
        }

        let promise = deleteChunks(&self.db_conn, &keys_array).await.map_err(|e| ProllyError::StorageError(format!("IDB delete failed: {:?}", e)))?;
        wasm_bindgen_futures::JsFuture::from(Promise::from(promise)).await.map_err(|e| ProllyError::StorageError(format!("IDB delete failed: {:?}", e)))?;
        
        Ok(())
    }

    async fn all_hashes(&self) -> Result<Vec<Hash>> {
        let promise = getAllKeys(&self.db_conn).await.map_err(|e| ProllyError::StorageError(format!("IDB getAllKeys failed: {:?}", e)))?;
        let keys_js = wasm_bindgen_futures::JsFuture::from(Promise::from(promise)).await.map_err(|e| ProllyError::StorageError(format!("IDB getAllKeys failed: {:?}", e)))?;
        let keys_array: js_sys::Array = keys_js.dyn_into().unwrap();
        
        let mut hashes = Vec::new();
        for key_js in keys_array.iter() {
            let key_u8 = key_js.dyn_into::<Uint8Array>().unwrap();
            let mut hash = [0u8; 32];
            key_u8.copy_to(&mut hash);
            hashes.push(hash);
        }
        
        Ok(hashes)
    }
}