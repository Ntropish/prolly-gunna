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
use crate::tree::Cursor; 
use crate::common::{TreeConfig, Key, Value, Hash};
use crate::error::ProllyError;
use crate::diff::DiffEntry;

use crate::tree::ScanArgs;

// Helper to convert ProllyError to JsValue
fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

/// Public wrapper for ProllyTree exported to JavaScript.
/// This will specifically use an InMemoryStore for Wasm.
#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmProllyTree {
    inner: Arc<tokio::sync::Mutex<ProllyTree<InMemoryStore>>>, // Mutex for interior mutability from &self in Wasm
    // Tokio runtime handle. We need a way to spawn futures.
    // For wasm_bindgen_futures::spawn_local, we don't strictly need to store a handle here.
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmProllyTreeCursor {
    inner: Arc<tokio::sync::Mutex<Cursor<InMemoryStore>>>,
}

#[wasm_bindgen]
impl WasmProllyTreeCursor {
    /// Advances the cursor and returns the next item.
    /// Returns a Promise resolving to an object like:
    /// `{ done: boolean, value?: [Uint8Array, Uint8Array] }`
    #[wasm_bindgen]
    pub fn next(&self) -> Promise {
        let cursor_clone: Arc<tokio::sync::Mutex<Cursor<InMemoryStore>>> = Arc::clone(&self.inner);
        let future = async move {
            let mut cursor_guard = cursor_clone.lock().await;
            // Use next_in_scan with default arguments for a simple forward iteration
            let default_args = ScanArgs::default();
            match cursor_guard.next_in_scan(&default_args).await { // <<< Using next_in_scan
                Ok(Some((key, value))) => {
                    let key_js = Uint8Array::from(&key[..]);
                    let val_js = Uint8Array::from(&value[..]);
                    let js_array = JsArray::new_with_length(2);
                    js_array.set(0, JsValue::from(key_js));
                    js_array.set(1, JsValue::from(val_js));

                    let result_obj = Object::new();
                    // Ensure proper error handling for Reflect::set, though unlikely to fail here
                    let _ = Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::FALSE);
                    let _ = Reflect::set(&result_obj, &JsValue::from_str("value"), &JsValue::from(js_array));
                    Ok(JsValue::from(result_obj))
                }
                Ok(None) => {
                    let result_obj = Object::new();
                    let _ = Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::TRUE);
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

    /// Re-hydrates a tree from a root hash, a JavaScript `Map` of chunks,
    /// and a JavaScript object representing the TreeConfig.
    /// The Map should have hash (Uint8Array) as keys and chunk_bytes (Uint8Array) as values.
    /// The tree_config_js should be an object matching the TreeConfig struct.
    #[wasm_bindgen(js_name = "load")]
    pub fn load(
        root_hash_js: Option<Uint8Array>, // Changed to Option<Uint8Array>
        chunks_js: &JsMap,
        tree_config_js: &JsValue, // tree_config_js is a JsValue representing the config object
    ) -> Promise {
        // Handle optional root_hash_js
        let root_h_opt: Option<Hash> = match root_hash_js {
            Some(rh_js) => {
                if rh_js.length() != 32 {
                    return Promise::reject(&JsValue::from_str("Root hash must be 32 bytes if provided"));
                }
                let mut h: Hash = [0u8; 32];
                rh_js.copy_to(&mut h);
                Some(h)
            }
            None => None, // Tree might be empty
        };

        let store = match InMemoryStore::from_js_map(chunks_js) {
            Ok(s) => Arc::new(s),
            Err(e) => return Promise::reject(&e),
        };

        // Deserialize tree_config_js into Rust TreeConfig struct
        let config: TreeConfig = match serde_wasm_bindgen::from_value(tree_config_js.clone()) {
            Ok(cfg) => cfg,
            Err(e) => {
                // If deserialization fails, you could fallback to default or reject.
                // Rejecting is safer if the config is critical and might be malformed.
                let error_msg = format!("Failed to deserialize TreeConfig: {}. Using default.", e);
                // For now, let's log and use default, but rejecting might be better in production.
                // If you want to reject:
                // return Promise::reject(&JsValue::from_str(&format!("Invalid TreeConfig: {}", e)));
                gloo_console::warn!(&error_msg); // Use gloo_console for wasm logging
                TreeConfig::default()
            }
        };
        
        // Basic validation matching the panic in ProllyTree::new, now returning a rejectable Promise
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
            return Promise::reject(&JsValue::from_str("Invalid TreeConfig values (fanout)."));
        }


        let future = async move {
            // If root_h_opt is None, it means we are loading an empty tree state,
            // but with a specific configuration and potentially some (unreferenced) chunks.
            // ProllyTree::new directly handles creating an empty tree with a config.
            // ProllyTree::from_root_hash expects a valid root_hash.
            
            let tree_result = if let Some(root_h) = root_h_opt {
                 ProllyTree::from_root_hash(root_h, store, config).await
            } else {
                // No root hash, so create a new empty tree with the given store and config.
                // The store will contain the chunks from chunks_js.
                // If these chunks are unreferenced by any live root (like the None root here),
                // they would be candidates for GC later if this tree remains empty or
                // if new roots are established that don't reference them.
                Ok(ProllyTree::new(store, config))
            };

            tree_result
                .map(|tree| {
                    let wasm_tree = WasmProllyTree {
                        inner: Arc::new(tokio::sync::Mutex::new(tree)),
                    };
                    wasm_tree.into()
                })
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

    #[wasm_bindgen(js_name = insertBatch)]
    pub fn insert_batch(&self, items_js: &JsArray) -> Promise {
        let mut items_rust: Vec<(Key, Value)> = Vec::with_capacity(items_js.length() as usize);

        for i in 0..items_js.length() {
            let pair_val = items_js.get(i);
            if let Some(pair_array) = pair_val.dyn_ref::<JsArray>() {
                if pair_array.length() == 2 {
                    let key_js = pair_array.get(0);
                    let value_js = pair_array.get(1);

                    if let (Some(key_u8), Some(value_u8)) = (key_js.dyn_ref::<Uint8Array>(), value_js.dyn_ref::<Uint8Array>()) {
                        items_rust.push((key_u8.to_vec(), value_u8.to_vec()));
                    } else {
                        return Promise::reject(&JsValue::from_str(&format!(
                            "Item at index {} in batch has non-Uint8Array key or value.", i
                        )));
                    }
                } else {
                    return Promise::reject(&JsValue::from_str(&format!(
                        "Item at index {} in batch is not a [key, value] pair.", i
                    )));
                }
            } else {
                return Promise::reject(&JsValue::from_str(&format!(
                    "Item at index {} in batch is not an array.", i
                )));
            }
        }

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let mut tree = tree_clone.lock().await; // Acquire lock for mutable access
            tree.insert_batch(items_rust).await
                .map(|_| JsValue::UNDEFINED) // insert_batch returns Result<()>, map to undefined on success
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

    #[wasm_bindgen(js_name = "getTreeConfig")]
    pub fn get_tree_config(&self) -> Promise { // Or return JsValue directly if simple enough
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            // Serialize tree.config to JsValue (e.g., using serde_json and then JsValue::from_serde)
            match serde_wasm_bindgen::to_value(&tree.config) {
                Ok(js_val) => Ok(js_val),
                Err(e) => Err(JsValue::from_str(&format!("Failed to serialize config: {}", e))),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = scanItems)]
    pub fn scan_items(
        &self,
        scan_args_js: JsValue, // Accept JsValue, which can be an object or undefined/null
    ) -> Promise {

        // Log the raw JSValue received for arguments
        gloo_console::debug!(format!("Rust scan_items: Received scan_args_js: {:?}", scan_args_js));


        // Deserialize ScanArgs from JsValue if it's an object, otherwise use default.
        let args_result: std::result::Result<ScanArgs, serde_wasm_bindgen::Error> = if scan_args_js.is_object() {
            serde_wasm_bindgen::from_value(scan_args_js)
        } else if scan_args_js.is_undefined() || scan_args_js.is_null() {
            Ok(ScanArgs::default()) // Use default if JS sends undefined/null
        } else {
            // If it's some other non-object type, that's an error.
            Err(serde_wasm_bindgen::Error::new("scanItems expects an object or null/undefined for arguments"))
        };

        let args = match args_result {
            Ok(a) => a,
            Err(e) => return Promise::reject(&JsValue::from_str(&format!("Invalid ScanArgs: {}", e))),
        };

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree_guard = tree_clone.lock().await;
            match tree_guard.scan(args).await { // This returns your internal ScanPage with Vec<u8>
                Ok(rust_scan_page) => {
                    // Manually construct the JS object
                    let result_obj = js_sys::Object::new();

                    // Items: Vec<(JsUint8Array, JsUint8Array)>
                    let js_items_array = js_sys::Array::new_with_length(rust_scan_page.items.len() as u32);
                    for (i, (k, v)) in rust_scan_page.items.into_iter().enumerate() {
                        let key_js = Uint8Array::from(k.as_slice());
                        let val_js = Uint8Array::from(v.as_slice());
                        let pair_array = js_sys::Array::new_with_length(2);
                        pair_array.set(0, JsValue::from(key_js));
                        pair_array.set(1, JsValue::from(val_js));
                        js_items_array.set(i as u32, JsValue::from(pair_array));
                    }
                    js_sys::Reflect::set(&result_obj, &JsValue::from_str("items"), &js_items_array)?;

                    js_sys::Reflect::set(&result_obj, &JsValue::from_str("hasNextPage"), &JsValue::from_bool(rust_scan_page.has_next_page))?;
                    js_sys::Reflect::set(&result_obj, &JsValue::from_str("hasPreviousPage"), &JsValue::from_bool(rust_scan_page.has_previous_page))?;

                    if let Some(cursor_key) = rust_scan_page.next_page_cursor {
                        let js_cursor = Uint8Array::from(cursor_key.as_slice());
                        js_sys::Reflect::set(&result_obj, &JsValue::from_str("nextPageCursor"), &js_cursor)?;
                    }
                    // If None, the field will be missing, which JS handles as undefined.

                    if let Some(cursor_key) = rust_scan_page.previous_page_cursor {
                        let js_cursor = Uint8Array::from(cursor_key.as_slice());
                        js_sys::Reflect::set(&result_obj, &JsValue::from_str("previousPageCursor"), &js_cursor)?;
                    }

                    Ok(JsValue::from(result_obj))
                }
                Err(e) => Err(prolly_error_to_jsvalue(e)),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = countAllItems)]
    pub fn count_all_items(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree_guard = tree_clone.lock().await; // Acquire read lock
            match tree_guard.count_all_items().await {
            Ok(count) => Ok(JsValue::from_f64(count as f64)), // JS numbers are f64
            Err(e) => Err(prolly_error_to_jsvalue(e)),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
}

