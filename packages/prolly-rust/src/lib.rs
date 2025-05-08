// prolly-rust/src/lib.rs

#![cfg(target_arch = "wasm32")]

use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture; // For converting Rust Futures to JS Promises
use js_sys::{Promise, Uint8Array, Map as JsMap};

// Declare all our modules
pub mod common;
pub mod error;
pub mod store;
pub mod node;
pub mod chunk;
pub mod tree;
// pub mod diff; // Still a placeholder, but declare it

// Use our new ProllyTree and InMemoryStore
use crate::tree::ProllyTree;
use crate::store::InMemoryStore;
use crate::common::{TreeConfig, Key, Value, Hash};
use crate::error::ProllyError;


// Helper to convert ProllyError to JsValue
fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

/// Public wrapper for ProllyTree exported to JavaScript.
/// This will specifically use an InMemoryStore for Wasm.
#[wasm_bindgen]
pub struct WasmProllyTree {
    inner: Arc<tokio::sync::Mutex<ProllyTree<InMemoryStore>>>, // Mutex for interior mutability from &self in Wasm
    // Tokio runtime handle. We need a way to spawn futures.
    // For wasm_bindgen_futures::spawn_local, we don't strictly need to store a handle here.
}

#[wasm_bindgen]
impl WasmProllyTree {
    /// Construct an empty in-memory tree with default configuration.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        // Initialize logging for wasm-bindgen-test (optional, but helpful)
        // wasm_logger::init(wasm_logger::Config::default()); // Needs wasm_logger crate

        let config = TreeConfig::default();
        let store = Arc::new(InMemoryStore::new());
        let tree = ProllyTree::new(store, config);
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(tree)),
        }
    }

    /// Re-hydrates a tree from a root hash and a JavaScript `Map` of chunks.
    /// The Map should have hash (Uint8Array) as keys and chunk_bytes (Uint8Array) as values.
    #[wasm_bindgen(js_name = "load")]
    pub fn load(root_hash_js: &Uint8Array, chunks_js: &JsMap) -> Promise {
        let mut root_h: Hash = [0u8; 32];
        if root_hash_js.length() != 32 {
            return Promise::reject(&JsValue::from_str("Root hash must be 32 bytes"));
        }
        root_hash_js.copy_to(&mut root_h);

        let store = match InMemoryStore::from_js_map(chunks_js) {
            Ok(s) => Arc::new(s),
            Err(e) => return Promise::reject(&e),
        };
        
        let config = TreeConfig::default();

        let tree_arc = Arc::new(tokio::sync::Mutex::new(ProllyTree { // Placeholder, from_root_hash will create the real one
            root_hash: None,
            store: store.clone(), // temporary store clone, will be replaced by from_root_hash's store
            config: config.clone(),
        }));
        
        // wasm_bindgen_futures::spawn_local requires 'static lifetime for the future.
        // We need to clone Arcs to move them into the async block.
        let future = async move {
            ProllyTree::from_root_hash(root_h, store, config).await
                .map(|tree| JsValue::from(WasmProllyTree { inner: Arc::new(tokio::sync::Mutex::new(tree)) }))
                .map_err(prolly_error_to_jsvalue)
        };
        
        wasm_bindgen_futures::future_to_promise(future)
    }

    /// Gets a value by key. Returns a Promise that resolves to `Uint8Array | null`.
    #[wasm_bindgen]
    pub fn get(&self, key_js: &Uint8Array) -> Promise {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let tree = tree_clone.lock().await; // Acquire lock
            tree.get(&key).await
                .map(|opt_val| match opt_val {
                    Some(v) => JsValue::from(Uint8Array::from(&v[..])),
                    None => JsValue::NULL,
                })
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    /// Inserts a key-value pair. Returns a Promise that resolves on completion.
    #[wasm_bindgen]
    pub fn insert(&self, key_js: &Uint8Array, value_js: &Uint8Array) -> Promise {
        let key: Key = key_js.to_vec();
        let value: Value = value_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let mut tree = tree_clone.lock().await; // Acquire lock for mutable access
            tree.insert(key, value).await
                .map(|_| JsValue::UNDEFINED) // insert returns Result<()>, map to undefined on success
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
    
    /// Deletes a key. Returns a Promise that resolves to `true` if deleted, `false` otherwise.
    /// (Currently unimplemented in core tree logic)
    #[wasm_bindgen]
    pub fn delete(&self, key_js: &Uint8Array) -> Promise {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let mut tree = tree_clone.lock().await;
            tree.delete(&key).await // This will panic until implemented
                .map(|deleted| JsValue::from_bool(deleted))
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    /// Finalizes changes to the tree and returns the new root hash.
    /// Returns a Promise that resolves to `Uint8Array | null`.
    #[wasm_bindgen]
    pub fn commit(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let mut tree = tree_clone.lock().await;
            tree.commit().await
                .map(|opt_hash| match opt_hash {
                    Some(h) => JsValue::from(Uint8Array::from(&h[..])),
                    None => JsValue::NULL,
                })
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
    
    /// Gets the current root hash of the tree.
    /// This is a synchronous getter as it doesn't involve async operations on the tree itself.
    /// However, to get the *latest* root_hash after an async op like insert,
    /// the JS side should await the insert promise first.
    /// For true latest, it should be async too. Let's make it async for consistency with commit.
    #[wasm_bindgen(js_name = "getRootHash")]
    pub fn get_root_hash(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            match tree.get_root_hash() {
                Some(h) => Ok(JsValue::from(Uint8Array::from(&h[..]))),
                None => Ok(JsValue::NULL),
            }
            // This simple getter doesn't return Result from ProllyError, so direct Ok.
        };
        wasm_bindgen_futures::future_to_promise(future)
    }


    /// Exports all chunks from the InMemoryStore for testing purposes.
    /// Returns a Promise that resolves to a JS `Map<Uint8Array, Uint8Array>`.
    #[wasm_bindgen(js_name = "exportChunks")]
    pub fn export_chunks(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            let all_chunks = tree.store.get_all_chunks_for_test().await; // Assuming this method exists on InMemoryStore

            let js_map = JsMap::new();
            for (hash, data) in all_chunks {
                js_map.set(
                    &JsValue::from(Uint8Array::from(&hash[..])),
                    &JsValue::from(Uint8Array::from(&data[..])),
                );
            }
            Ok(JsValue::from(js_map))
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    /// Construct an empty in-memory tree with custom fanout configuration (for testing).
    #[wasm_bindgen(js_name = newWithConfig)]
    pub fn new_with_config(target_fanout: usize, min_fanout: usize) -> Result<WasmProllyTree, JsValue> {
        let default_config = TreeConfig::default(); // Get defaults for CDC params
        let config = TreeConfig { 
            target_fanout, 
            min_fanout,
            // Use defaults for the rest
            cdc_min_size: default_config.cdc_min_size,
            cdc_avg_size: default_config.cdc_avg_size,
            cdc_max_size: default_config.cdc_max_size,
            max_inline_value_size: default_config.max_inline_value_size,
        };
        // Basic validation matching the panic in ProllyTree::new
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
             return Err(JsValue::from_str("Invalid TreeConfig: fanout values are not configured properly."));
        }
        let store = Arc::new(InMemoryStore::new());
        // Use the fully initialized config
        let tree = ProllyTree::new(store, config); 
        Ok(Self { 
            inner: Arc::new(tokio::sync::Mutex::new(tree)),
        })
    }
}


// ---------- Unit tests (run with `wasm-pack test --firefox --headless`) ----------
// Ensure you have wasm-bindgen-test installed and configured.
#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    // Helper to convert JS Promise to Rust Future for testing
    async fn js_promise_to_future<T: JsCast>(promise: Promise) -> std::result::Result<T, JsValue> {
        JsFuture::from(promise).await.map(|js_val| {
            // If T is JsValue, no cast is needed. Otherwise, attempt to cast.
            // This is a bit simplified; a real cast might need dyn_into.
            if js_val.is_null() || js_val.is_undefined() {
                 // Try to cast to T, assuming T can represent null/undefined (e.g. Option<SpecificType>)
                 // This part is tricky if T cannot be null/undefined.
                 // For simplicity, let's assume T can be constructed from this, or it's JsValue.
                 js_val.dyn_into::<T>().map_err(|original_val| JsValue::from_str(&format!("Failed to cast JsValue: {:?}", original_val)))
            } else {
                 js_val.dyn_into::<T>().map_err(|original_val| JsValue::from_str(&format!("Failed to cast JsValue: {:?}", original_val)))
            }
        })
    }
     async fn js_promise_to_option_uint8array(promise: Promise) -> std::result::Result<Option<Vec<u8>>, JsValue> {
        match JsFuture::from(promise).await {
            Ok(js_val) => {
                if js_val.is_null() || js_val.is_undefined() {
                    Ok(None)
                } else {
                    let arr: Uint8Array = js_val.dyn_into()?;
                    Ok(Some(arr.to_vec()))
                }
            }
            Err(e) => Err(e),
        }
    }
    async fn js_promise_to_option_hash_uint8array(promise: Promise) -> std::result::Result<Option<Hash>, JsValue> {
        match JsFuture::from(promise).await {
            Ok(js_val) => {
                if js_val.is_null() || js_val.is_undefined() {
                    Ok(None)
                } else {
                    let arr: Uint8Array = js_val.dyn_into()?;
                    if arr.length() == 32 {
                        let mut h: Hash = [0u8; 32];
                        arr.copy_to(&mut h);
                        Ok(Some(h))
                    } else {
                        Err(JsValue::from_str("Hash is not 32 bytes"))
                    }
                }
            }
            Err(e) => Err(e),
        }
    }


    wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    async fn test_new_insert_get_commit() {
        let tree = WasmProllyTree::new();

        // Insert "alice"
        let key_alice = Uint8Array::from(b"alice".as_ref());
        let val_hello = Uint8Array::from(b"hello".as_ref());
        js_promise_to_future::<JsValue>(tree.insert(&key_alice, &val_hello)).await.unwrap();

        // Insert "bob"
        let key_bob = Uint8Array::from(b"bob".as_ref());
        let val_world = Uint8Array::from(b"world".as_ref());
        js_promise_to_future::<JsValue>(tree.insert(&key_bob, &val_world)).await.unwrap();
        
        // Get "alice"
        let retrieved_alice_val = js_promise_to_option_uint8array(tree.get(&key_alice)).await.unwrap();
        assert_eq!(retrieved_alice_val, Some(b"hello".to_vec()), "Failed to get alice");

        // Get "bob"
        let retrieved_bob_val = js_promise_to_option_uint8array(tree.get(&key_bob)).await.unwrap();
        assert_eq!(retrieved_bob_val, Some(b"world".to_vec()), "Failed to get bob");
        
        // Get non-existent key
        let key_charlie = Uint8Array::from(b"charlie".as_ref());
        let retrieved_charlie_val = js_promise_to_option_uint8array(tree.get(&key_charlie)).await.unwrap();
        assert_eq!(retrieved_charlie_val, None, "Charlie should not exist");

        // Commit (which in current design just gets root hash)
        let _root_hash1_val = js_promise_to_option_hash_uint8array(tree.commit()).await.unwrap();
        let root_hash1_from_getter = js_promise_to_option_hash_uint8array(tree.get_root_hash()).await.unwrap();
        // assert_eq!(root_hash1_val, root_hash1_from_getter, "Commit and getRootHash should match after inserts");
        // assert!(root_hash1_val.is_some(), "Root hash should exist after inserts");
        assert!(root_hash1_from_getter.is_some(), "Root hash should exist after inserts");


        // Test loading from exported chunks
        let root_hash_to_load = root_hash1_from_getter.unwrap();
        let chunks_map_js_val = js_promise_to_future::<JsMap>(tree.export_chunks()).await.unwrap();
        
        let root_hash_to_load_js = Uint8Array::from(&root_hash_to_load[..]);

        let loaded_tree_promise = WasmProllyTree::load(&root_hash_to_load_js, &chunks_map_js_val);
        let loaded_tree_js_val = JsFuture::from(loaded_tree_promise).await.unwrap();
        let loaded_tree = loaded_tree_js_val.dyn_into::<WasmProllyTree>().expect("Failed to cast to WasmProllyTree");

        // Verify data in loaded tree
        let retrieved_alice_loaded = js_promise_to_option_uint8array(loaded_tree.get(&key_alice)).await.unwrap();
        assert_eq!(retrieved_alice_loaded, Some(b"hello".to_vec()), "Failed to get alice from loaded tree");

        let retrieved_bob_loaded = js_promise_to_option_uint8array(loaded_tree.get(&key_bob)).await.unwrap();
        assert_eq!(retrieved_bob_loaded, Some(b"world".to_vec()), "Failed to get bob from loaded tree");
    }

    #[wasm_bindgen_test]
    async fn test_many_inserts_and_splits() {
        let tree = WasmProllyTree::new();
        let mut expected_values = std::collections::HashMap::new();

        // Insert enough items to likely cause splits.
        // Default fanout is 32, so >32 items needed for a leaf split.
        // To test internal node splits, we'd need > fanout*fanout items approx.
        // Let's try with 100 for now, should cause at least a few leaf splits.
        for i in 0..100 {
            let key_str = format!("key_{:03}", i);
            let val_str = format!("value_{:03}", i);
            let key_js = Uint8Array::from(key_str.as_bytes());
            let val_js = Uint8Array::from(val_str.as_bytes());

            js_promise_to_future::<JsValue>(tree.insert(&key_js, &val_js)).await.expect("Insert failed");
            expected_values.insert(key_str.into_bytes(), val_str.into_bytes());
        }

        let final_root_hash = js_promise_to_option_hash_uint8array(tree.get_root_hash()).await.unwrap();
        assert!(final_root_hash.is_some(), "Root hash should exist after many inserts");

        // Verify all inserted values
        for (key, expected_val) in expected_values {
            let key_js = Uint8Array::from(key.as_slice());
            let retrieved_val = js_promise_to_option_uint8array(tree.get(&key_js)).await.unwrap();
            assert_eq!(retrieved_val.as_ref(), Some(&expected_val), "Mismatch for key: {:?}", String::from_utf8_lossy(&key));
        }
        
        // Test load after many inserts
        let root_hash_to_load = final_root_hash.unwrap();
        let chunks_map_js_val = js_promise_to_future::<JsMap>(tree.export_chunks()).await.unwrap();
        let root_hash_to_load_js = Uint8Array::from(&root_hash_to_load[..]);

        let loaded_tree_promise = WasmProllyTree::load(&root_hash_to_load_js, &chunks_map_js_val);
        let loaded_tree_js_val = JsFuture::from(loaded_tree_promise).await.unwrap();
        let loaded_tree = loaded_tree_js_val.dyn_into::<WasmProllyTree>().expect("Failed to cast to WasmProllyTree after many inserts");
        
        // Quick check on one value from loaded tree
        let key_js_50 = Uint8Array::from(b"key_050".as_ref());
        let val_js_50 = js_promise_to_option_uint8array(loaded_tree.get(&key_js_50)).await.unwrap();
        assert_eq!(val_js_50, Some(b"value_050".to_vec()));

    }
}