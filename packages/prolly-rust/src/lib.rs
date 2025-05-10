// prolly-rust/src/lib.rs

#![cfg(target_arch = "wasm32")]

use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[cfg(test)]
use wasm_bindgen_futures::JsFuture; 

use js_sys::{Promise, Uint8Array, Map as JsMap, Object, Reflect, Array as JsArray}; // Added Object, Reflect

// Declare all our modules
pub mod common;
pub mod error;
pub mod store;
pub mod node;
pub mod chunk;
pub mod tree;
pub mod diff; 
pub mod gc;

// Use our new ProllyTree and InMemoryStore
use crate::tree::ProllyTree;
use crate::store::InMemoryStore;
use crate::tree::Cursor; // Ensure Cursor is imported
use tokio::sync::Mutex; // Ensure Mutex is imported
use crate::common::{TreeConfig, Key, Value, Hash};
use crate::error::ProllyError;
use crate::diff::DiffEntry; // Make sure DiffEntry is imported

// Helper to convert ProllyError to JsValue
fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

/// Public wrapper for ProllyTree exported to JavaScript.
/// This will specifically use an InMemoryStore for Wasm.
#[wasm_bindgen(inspectable)]
pub struct WasmProllyTree {
    inner: Arc<tokio::sync::Mutex<ProllyTree<InMemoryStore>>>, // Mutex for interior mutability from &self in Wasm
    // Tokio runtime handle. We need a way to spawn futures.
    // For wasm_bindgen_futures::spawn_local, we don't strictly need to store a handle here.
}

#[wasm_bindgen]
pub struct WasmProllyTreeCursor {
    inner: Arc<Mutex<Cursor<InMemoryStore>>>, // Explicit type here helps definition
}

#[wasm_bindgen]
impl WasmProllyTreeCursor {
    /// Advances the cursor and returns the next item.
    /// Returns a Promise resolving to an object like:
    /// `{ done: boolean, value?: [Uint8Array, Uint8Array] }`
    #[wasm_bindgen]
    pub fn next(&self) -> Promise {
        // Add explicit type annotation here
        let cursor_clone: Arc<Mutex<Cursor<InMemoryStore>>> = Arc::clone(&self.inner);

        let future = async move {
            let mut cursor = cursor_clone.lock().await; // Lock for mutable access to advance
            match cursor.next().await {
                Ok(Some((key, value))) => {
                    // Create the result object { done: false, value: [key, value] }
                    let key_js = Uint8Array::from(&key[..]);
                    let val_js = Uint8Array::from(&value[..]);
                    let js_array = js_sys::Array::new();
                    js_array.push(&JsValue::from(key_js));
                    js_array.push(&JsValue::from(val_js));

                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::FALSE)?;
                    Reflect::set(&result_obj, &JsValue::from_str("value"), &JsValue::from(js_array))?;
                    Ok(JsValue::from(result_obj))
                }
                Ok(None) => {
                    // Create the result object { done: true }
                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::TRUE)?;
                    Ok(JsValue::from(result_obj))
                }
                Err(e) => Err(prolly_error_to_jsvalue(e)),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
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

        // let tree_arc = Arc::new(tokio::sync::Mutex::new(ProllyTree { // Placeholder, from_root_hash will create the real one
        //     root_hash: None,
        //     store: store.clone(), // temporary store clone, will be replaced by from_root_hash's store
        //     config: config.clone(),
        // }));
        
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

    /// Creates a cursor starting before the first key-value pair.
    /// Returns a Promise resolving to a WasmProllyTreeCursor.
    #[wasm_bindgen(js_name = cursorStart)]
    pub fn cursor_start(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
             let tree = tree_clone.lock().await;
             tree.cursor_start().await
                .map(|cursor| JsValue::from(WasmProllyTreeCursor { inner: Arc::new(tokio::sync::Mutex::new(cursor)) }))
                .map_err(prolly_error_to_jsvalue)
        };
         wasm_bindgen_futures::future_to_promise(future)
    }

    /// Creates a cursor starting at or just after the given key.
    /// Returns a Promise resolving to a WasmProllyTreeCursor.
    #[wasm_bindgen]
     pub fn seek(&self, key_js: &Uint8Array) -> Promise {
         let key: Key = key_js.to_vec();
         let tree_clone = Arc::clone(&self.inner);
         let future = async move {
              let tree = tree_clone.lock().await;
              tree.seek(&key).await
                 .map(|cursor| JsValue::from(WasmProllyTreeCursor { inner: Arc::new(tokio::sync::Mutex::new(cursor)) }))
                 .map_err(prolly_error_to_jsvalue)
         };
          wasm_bindgen_futures::future_to_promise(future)
     }

    /// Computes the differences between two tree states represented by their root hashes,
    /// using the chunk store associated with THIS tree instance.
    ///
    /// Requires that the underlying store contains all necessary chunks for *both* tree versions.
    /// Pass `null` or `undefined` for a hash to represent an empty tree.
    ///
    /// Returns a Promise resolving to an array of diff objects:
    /// `Array<{ key: Uint8Array, leftValue?: Uint8Array, rightValue?: Uint8Array }>`
    #[wasm_bindgen(js_name = diffRoots)] // Renamed JS function
    pub fn diff_roots( // Renamed Rust function
        &self, // Still needs &self to access the store and config
        root_hash_left_js: Option<Uint8Array>, 
        root_hash_right_js: Option<Uint8Array>
    ) -> Promise {
        // Validate and convert left_hash
        let hash_left_opt: Option<Hash> = match root_hash_left_js {
            Some(js_arr) => {
                if js_arr.length() == 32 {
                    let mut h: Hash = [0u8; 32];
                    js_arr.copy_to(&mut h);
                    Some(h)
                } else {
                    return Promise::reject(&JsValue::from_str("Invalid root_hash_left length, must be 32 bytes or null/undefined"));
                }
            }
            None => None, 
        };
        
        // Validate and convert right_hash
         let hash_right_opt: Option<Hash> = match root_hash_right_js {
            Some(js_arr) => {
                if js_arr.length() == 32 {
                    let mut h: Hash = [0u8; 32];
                    js_arr.copy_to(&mut h);
                    Some(h)
                } else {
                    return Promise::reject(&JsValue::from_str("Invalid root_hash_right length, must be 32 bytes or null/undefined"));
                }
            }
            None => None, 
        };

        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let tree = tree_clone.lock().await;
            // Call the core diff logic with the two specified roots
            crate::diff::diff_trees( 
                hash_left_opt, 
                hash_right_opt, 
                Arc::clone(&tree.store), // Use the store from this instance
                tree.config.clone()     // Use the config from this instance
            ).await 
                .map(|diff_entries: Vec<DiffEntry>| {
                    // --- Convert Vec<DiffEntry> to JsArray of JS Objects ---
                    // (Keep the conversion logic from the previous diff implementation)
                    let js_result_array = JsArray::new_with_length(diff_entries.len() as u32);
                    for (index, entry) in diff_entries.iter().enumerate() {
                        let js_entry_obj = Object::new();
                        Reflect::set( &js_entry_obj, &JsValue::from_str("key"), &JsValue::from(Uint8Array::from(entry.key.as_slice())) ).unwrap_or_else(|_| panic!("Failed to set key"));
                        if let Some(ref lv) = entry.left_value { Reflect::set( &js_entry_obj, &JsValue::from_str("leftValue"), &JsValue::from(Uint8Array::from(lv.as_slice())) ).unwrap_or_else(|_| panic!("Failed to set leftValue")); }
                        if let Some(ref rv) = entry.right_value { Reflect::set( &js_entry_obj, &JsValue::from_str("rightValue"), &JsValue::from(Uint8Array::from(rv.as_slice())) ).unwrap_or_else(|_| panic!("Failed to set rightValue")); }
                        js_result_array.set(index as u32, JsValue::from(js_entry_obj));
                    }
                    JsValue::from(js_result_array) 
                    // --- End Conversion ---
                })
                .map_err(prolly_error_to_jsvalue) 
        };

        wasm_bindgen_futures::future_to_promise(future)
    }


    /// Triggers garbage collection on the underlying store.
    ///
    /// The `live_root_hashes_js` should be a JavaScript array of `Uint8Array`s,
    /// where each `Uint8Array` is a 32-byte root hash that should be considered live.
    /// The current `WasmProllyTree` instance's own root hash will automatically be
    /// included in the set of live roots if it exists.
    ///
    /// Returns a Promise that resolves with the number of chunks collected.
    #[wasm_bindgen(js_name = triggerGc)]
    pub fn trigger_gc(&self, live_root_hashes_js: &JsArray) -> Promise {
        let mut live_root_hashes_rust: Vec<Hash> = Vec::new();

        for i in 0..live_root_hashes_js.length() {
            let val = live_root_hashes_js.get(i);
            if let Some(js_uint8_array) = val.dyn_ref::<Uint8Array>() {
                if js_uint8_array.length() == 32 {
                    let mut hash_arr: Hash = [0u8; 32];
                    js_uint8_array.copy_to(&mut hash_arr);
                    live_root_hashes_rust.push(hash_arr);
                } else {
                    return Promise::reject(&JsValue::from_str(&format!(
                        "Invalid hash length at index {}: expected 32, got {}",
                        i,
                        js_uint8_array.length()
                    )));
                }
            } else {
                return Promise::reject(&JsValue::from_str(&format!(
                    "Element at index {} is not a Uint8Array",
                    i
                )));
            }
        }

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await; // Lock to access the tree's gc method
            tree.gc(&live_root_hashes_rust).await // Call the ProllyTree::gc method
                .map(|count| JsValue::from_f64(count as f64)) // Convert usize to JS number
                .map_err(prolly_error_to_jsvalue)
        };

        wasm_bindgen_futures::future_to_promise(future)
    }

}


// ---------- Unit tests (run with `wasm-pack test --firefox --headless`) ----------
// Ensure you have wasm-bindgen-test installed and configured.
#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::*;
    use js_sys::JsString;

    #[wasm_bindgen(inspectable)]
    pub struct TestInternalDummy { // Defined inside mod tests
        _field: Option<JsString>,
    }


    #[wasm_bindgen_test]
    fn test_internal_dummy_cast() {
        let dummy = TestInternalDummy { _field: None };
        let js_val: JsValue = JsValue::from(dummy); // Convert Rust struct to JsValue

        // Attempt to cast it back
        let _casted_dummy: TestInternalDummy = js_val
            .dyn_into::<TestInternalDummy>()
            .expect("dyn_into failed for TestInternalDummy defined within tests module");
    }

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
        })?
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
    async fn js_promise_to_f64(promise: Promise) -> std::result::Result<f64, JsValue> {
        let js_val = JsFuture::from(promise).await?;
        js_val.as_f64().ok_or_else(|| JsValue::from_str("Result was not a number"))
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

        // packages/prolly-rust/src/lib.rs
        let loaded_tree_promise = WasmProllyTree::load(&root_hash_to_load_js, &chunks_map_js_val);
        let loaded_tree_js_val: JsValue = wasm_bindgen_futures::JsFuture::from(loaded_tree_promise)
            .await
            .expect("Promise from WasmProllyTree::load failed");

        // Now, attempt the direct cast:
        let loaded_tree: WasmProllyTree = loaded_tree_js_val
            .dyn_into::<WasmProllyTree>()
            .expect("JsValue.dyn_into::<WasmProllyTree>() failed in test_new_insert_get_commit");

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

        // ... (loop for inserts) ...
        for i in 0..100 {
            let key_str = format!("key_{:03}", i);
            let val_str = format!("value_{:03}", i);
            let key_js = Uint8Array::from(key_str.as_bytes());
            let val_js = Uint8Array::from(val_str.as_bytes());
            // Assuming js_promise_to_future is still present or use direct JsFuture::from for consistency
            wasm_bindgen_futures::JsFuture::from(tree.insert(&key_js, &val_js)).await.expect("Insert failed");
            expected_values.insert(key_str.into_bytes(), val_str.into_bytes());
        }

        let final_root_hash = js_promise_to_option_hash_uint8array(tree.get_root_hash()).await.unwrap();
        assert!(final_root_hash.is_some(), "Root hash should exist after many inserts");

        let root_hash_to_load = final_root_hash.unwrap();
        let chunks_map_js_val = js_promise_to_future::<JsMap>(tree.export_chunks()).await.unwrap(); // Or direct await
        let root_hash_to_load_js = Uint8Array::from(&root_hash_to_load[..]);

        // >>> FIX for E0425: Define loaded_tree_promise here <<<
        let loaded_tree_promise = WasmProllyTree::load(&root_hash_to_load_js, &chunks_map_js_val); 

        let loaded_tree_js_val: JsValue = wasm_bindgen_futures::JsFuture::from(loaded_tree_promise)
            .await
            .expect("Promise from WasmProllyTree::load failed in test_many_inserts_and_splits");

        let loaded_tree: WasmProllyTree = loaded_tree_js_val
            .dyn_into::<WasmProllyTree>() // This is line 590 in your error
            .expect("JsValue.dyn_into::<WasmProllyTree>() failed in test_many_inserts_and_splits");

        let key_js_50 = Uint8Array::from(b"key_050".as_ref());
        let val_js_50 = js_promise_to_option_uint8array(loaded_tree.get(&key_js_50)).await.unwrap();
        assert_eq!(val_js_50, Some(b"value_050".to_vec()));
    }

    #[wasm_bindgen_test]
    async fn test_gc_simple_case() {
        let tree = WasmProllyTree::new();

        // State 1: Add item1
        let key1 = Uint8Array::from(b"item1".as_ref());
        let val1 = Uint8Array::from(b"value1".as_ref());
        js_promise_to_future::<JsValue>(tree.insert(&key1, &val1)).await.unwrap();
        let root_hash1_opt = js_promise_to_option_hash_uint8array(tree.get_root_hash()).await.unwrap();
        assert!(root_hash1_opt.is_some(), "Root hash 1 should exist");
        let root_hash1 = root_hash1_opt.unwrap();
        let _root_hash1_js = Uint8Array::from(&root_hash1[..]);

        // State 2: Add item2 (tree now contains item1, item2)
        let key2 = Uint8Array::from(b"item2".as_ref());
        let val2 = Uint8Array::from(b"value2".as_ref());
        js_promise_to_future::<JsValue>(tree.insert(&key2, &val2)).await.unwrap();
        let root_hash2_opt = js_promise_to_option_hash_uint8array(tree.get_root_hash()).await.unwrap();
        assert!(root_hash2_opt.is_some(), "Root hash 2 should exist");
        let root_hash2 = root_hash2_opt.unwrap();
        let root_hash2_js = Uint8Array::from(&root_hash2[..]);

        assert_ne!(root_hash1, root_hash2, "Root hashes should differ");

        let chunks_before_gc = js_promise_to_future::<JsMap>(tree.export_chunks()).await.unwrap();
        let num_chunks_before_gc = chunks_before_gc.size();
        // Expected chunks:
        // R1 related: Leaf("item1"), Root1 (if item1 caused a split, or if it's the only node)
        // R2 related: Potentially a new leaf for "item2", updated leaf for "item1" (if not split), new Root2
        // Exact number is tricky without knowing split points, but should be > 1.
        // For this simple case, if no splits:
        // Leaf1(item1) -> chunkA
        // Root1 is chunkA hash
        // Leaf2(item1, item2) -> chunkB
        // Root2 is chunkB hash
        // So, 2 chunks if fully rewritten: chunkA, chunkB.
        // If item1's node was updated to include item2: 1 chunk + old item1 node becomes garbage.

        // Trigger GC, keeping only root_hash2 live
        let live_roots_js_array = JsArray::new();
        live_roots_js_array.push(&root_hash2_js.into()); // Pass R2 as live

        let collected_count_promise = tree.trigger_gc(&live_roots_js_array);
        let collected_count = js_promise_to_f64(collected_count_promise).await.unwrap() as usize;

        // Assert that some chunks were collected (chunks unique to root_hash1)
        // The exact number depends on tree structure & chunking.
        // If R1 was a single leaf node, and R2 updated that leaf, then R1's chunk should be collected.
        assert!(collected_count > 0, "Expected some chunks to be collected. Collected: {}", collected_count);

        let chunks_after_gc = js_promise_to_future::<JsMap>(tree.export_chunks()).await.unwrap();
        let num_chunks_after_gc = chunks_after_gc.size();

        assert_eq!(
            num_chunks_before_gc - (collected_count as u32),
            num_chunks_after_gc,
            "Chunk count mismatch after GC"
        );

        // Verify that data for root_hash2 is still accessible
        let retrieved_val1_after_gc = js_promise_to_option_uint8array(tree.get(&key1)).await.unwrap();
        assert_eq!(retrieved_val1_after_gc, Some(val1.to_vec()), "Item1 should still be accessible after GC for R2");
        let retrieved_val2_after_gc = js_promise_to_option_uint8array(tree.get(&key2)).await.unwrap();
        assert_eq!(retrieved_val2_after_gc, Some(val2.to_vec()), "Item2 should still be accessible after GC for R2");

        // Attempt to load tree with old root_hash1 should fail or yield incomplete data
        // as its chunks might have been GC'd. This requires a fresh load.
        let fresh_store_after_gc = InMemoryStore::from_js_map(&chunks_after_gc).unwrap();
        let tree_loaded_with_r1_attempt = ProllyTree::from_root_hash(root_hash1, Arc::new(fresh_store_after_gc), TreeConfig::default()).await;
        
        // It's expected that loading from root_hash1 might fail if its unique chunks were collected.
        assert!(tree_loaded_with_r1_attempt.is_err(), "Loading from old root_hash1 should fail after GC if its chunks were collected.");
        if let Err(ProllyError::ChunkNotFound(_)) = tree_loaded_with_r1_attempt {
            // This is the expected error if a chunk for R1 was GC'd
        } else if tree_loaded_with_r1_attempt.is_ok() {
             // If it loads, it means R1 was an ancestor of R2 or shared all chunks.
             // We'd need to check if all chunks for R1 are present in chunks_after_gc
             // This scenario is fine if R1's chunks were also R2's chunks.
             // The key is that *uniquely R1* chunks are gone.
        }
    }
}