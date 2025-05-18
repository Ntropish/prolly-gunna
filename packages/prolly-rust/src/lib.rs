// prolly-rust/src/lib.rs

#![cfg(target_arch = "wasm32")]

use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[cfg(test)]
use wasm_bindgen_futures::JsFuture;

// Import JsValue types from js_sys
use js_sys::{Promise, Uint8Array as JsUint8Array, Map as JsMap, Object, Reflect, Array as JsArray};


// Declare all our modules
pub mod common;
pub mod error;
pub mod store;
pub mod node;
pub mod chunk;
pub mod tree;
pub mod diff;
pub mod gc;
pub mod wasm_bridge;

// Corrected use statements
use crate::tree::types as core_tree_types; // For core ScanArgs and ScanPage
use crate::wasm_bridge::WasmScanPage;       // For the WasmScanPage return type
use serde_wasm_bindgen;                    // For from_value

use crate::tree::ProllyTree;
use crate::store::InMemoryStore;
// tree::Cursor is used in WasmProllyTreeCursor
use crate::common::{TreeConfig, Key, Value, Hash};
use crate::error::ProllyError;
use crate::diff::DiffEntry;


// Helper to convert ProllyError to JsValue
fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

// --- TypeScript Custom Section for ScanOptions ---
const SCAN_OPTIONS_TS_DEF: &str = r#"
/**
 * Options for the scanItems operation.
 * All fields are optional and will use reasonable defaults on the Rust side if not provided.
 */
export interface ScanOptions {
  startBound?: Uint8Array | null;
  endBound?: Uint8Array | null;
  startInclusive?: boolean | null;
  endInclusive?: boolean | null;
  reverse?: boolean | null;
  /** Corresponds to u64 in Rust. Use JavaScript BigInt for large numbers. */
  offset?: bigint | number | null; 
  limit?: number | null;
}

type ScanItemsFn = (options?: ScanOptions) => Promise<WasmScanPage>
"#;

// CORRECTED PLACEMENT: Attribute is on the const, not the struct
#[wasm_bindgen(typescript_custom_section)]
const TS_APPEND_CONTENT: &'static str = SCAN_OPTIONS_TS_DEF;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "ScanOptions")]
    pub type ScanOptions;
}

// --- End TypeScript Custom Section ---


/// Public wrapper for ProllyTree exported to JavaScript.
#[wasm_bindgen] // Removed incorrect typescript_custom_section from here
#[derive(Clone)]
pub struct WasmProllyTree {
    inner: Arc<tokio::sync::Mutex<ProllyTree<InMemoryStore>>>,
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmProllyTreeCursor {
    inner: Arc<tokio::sync::Mutex<tree::Cursor<InMemoryStore>>>,
}

#[wasm_bindgen]
impl WasmProllyTreeCursor {
    #[wasm_bindgen]
    pub fn next(&self) -> Promise {
        let cursor_clone: Arc<tokio::sync::Mutex<tree::Cursor<InMemoryStore>>> = Arc::clone(&self.inner);
        let future = async move {
            let mut cursor_guard = cursor_clone.lock().await;
            let default_core_args = core_tree_types::ScanArgs::default(); 
            match cursor_guard.next_in_scan(&default_core_args).await {
                Ok(Some((key, value))) => {
                    let key_js = JsUint8Array::from(&key[..]);
                    let val_js = JsUint8Array::from(&value[..]);
                    let js_array = JsArray::new_with_length(2);
                    js_array.set(0, JsValue::from(key_js));
                    js_array.set(1, JsValue::from(val_js));

                    let result_obj = Object::new();
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
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let config = TreeConfig::default();
        let store = Arc::new(InMemoryStore::new());
        let tree = ProllyTree::new(store, config);
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(tree)),
        }
    }

    #[wasm_bindgen(js_name = "load")]
    pub fn load(
        root_hash_js: Option<JsUint8Array>,
        chunks_js: &JsMap,
        tree_config_js: &JsValue,
    ) -> Promise {
        let root_h_opt: Option<Hash> = match root_hash_js {
            Some(rh_js) => {
                if rh_js.length() != 32 {
                    return Promise::reject(&JsValue::from_str("Root hash must be 32 bytes if provided"));
                }
                let mut h: Hash = [0u8; 32];
                rh_js.copy_to(&mut h);
                Some(h)
            }
            None => None,
        };

        let store = match InMemoryStore::from_js_map(chunks_js) {
            Ok(s) => Arc::new(s),
            Err(e) => return Promise::reject(&e),
        };
        
        let config: TreeConfig = match serde_wasm_bindgen::from_value(tree_config_js.clone()) {
            Ok(cfg) => cfg,
            Err(e) => {
                gloo_console::warn!(&format!("Failed to deserialize TreeConfig: {}. Using default.", e));
                TreeConfig::default()
            }
        };
        
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
            return Promise::reject(&JsValue::from_str("Invalid TreeConfig values (fanout)."));
        }

        let future = async move {
            let tree_result = if let Some(root_h) = root_h_opt {
                 ProllyTree::from_root_hash(root_h, store, config).await
            } else {
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

    // ... (get, insert, insert_batch, delete, commit, get_root_hash, export_chunks, new_with_config, cursor_start, seek, diff_roots, trigger_gc, get_tree_config - keep these as they are in your file) ...
    // For brevity, I'm omitting the full bodies of these other functions, but they should be identical
    // to your uploaded file, unless they also need similar TypeScript type enhancements.

    #[wasm_bindgen]
    pub fn get(&self, key_js: &JsUint8Array) -> Promise {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let tree = tree_clone.lock().await; // Acquire lock
            tree.get(&key).await
                .map(|opt_val| match opt_val {
                    Some(v) => JsValue::from(JsUint8Array::from(&v[..])),
                    None => JsValue::NULL,
                })
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen]
    pub fn insert(&self, key_js: &JsUint8Array, value_js: &JsUint8Array) -> Promise {
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
                    let key_js_val = pair_array.get(0);
                    let value_js_val = pair_array.get(1);

                    if let (Some(key_u8), Some(value_u8)) = (key_js_val.dyn_ref::<JsUint8Array>(), value_js_val.dyn_ref::<JsUint8Array>()) {
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
    
    #[wasm_bindgen]
    pub fn delete(&self, key_js: &JsUint8Array) -> Promise {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);

        let future = async move {
            let mut tree = tree_clone.lock().await;
            tree.delete(&key).await 
                .map(|deleted| JsValue::from_bool(deleted))
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen]
    pub fn commit(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let mut tree = tree_clone.lock().await;
            tree.commit().await
                .map(|opt_hash| match opt_hash {
                    Some(h) => JsValue::from(JsUint8Array::from(&h[..])),
                    None => JsValue::NULL,
                })
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
    
    #[wasm_bindgen(js_name = "getRootHash")]
    pub fn get_root_hash(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            match tree.get_root_hash() {
                Some(h) => Ok(JsValue::from(JsUint8Array::from(&h[..]))),
                None => Ok(JsValue::NULL),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = "exportChunks")]
    pub fn export_chunks(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            let all_chunks = tree.store.get_all_chunks_for_test().await; 

            let js_map = JsMap::new();
            for (hash, data) in all_chunks {
                js_map.set(
                    &JsValue::from(JsUint8Array::from(&hash[..])),
                    &JsValue::from(JsUint8Array::from(&data[..])),
                );
            }
            Ok(JsValue::from(js_map))
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = newWithConfig)]
    pub fn new_with_config(target_fanout: usize, min_fanout: usize) -> Result<WasmProllyTree, JsValue> {
        let default_config = TreeConfig::default(); 
        let config = TreeConfig { 
            target_fanout, 
            min_fanout,
            cdc_min_size: default_config.cdc_min_size,
            cdc_avg_size: default_config.cdc_avg_size,
            cdc_max_size: default_config.cdc_max_size,
            max_inline_value_size: default_config.max_inline_value_size,
        };
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
             return Err(JsValue::from_str("Invalid TreeConfig: fanout values are not configured properly."));
        }
        let store = Arc::new(InMemoryStore::new());
        let tree = ProllyTree::new(store, config); 
        Ok(Self { 
            inner: Arc::new(tokio::sync::Mutex::new(tree)),
        })
    }

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

    #[wasm_bindgen]
     pub fn seek(&self, key_js: &JsUint8Array) -> Promise {
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

    #[wasm_bindgen(js_name = diffRoots)]
    pub fn diff_roots( 
        &self, 
        root_hash_left_js: Option<JsUint8Array>, 
        root_hash_right_js: Option<JsUint8Array>
    ) -> Promise {
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
            crate::diff::diff_trees( 
                hash_left_opt, 
                hash_right_opt, 
                Arc::clone(&tree.store), 
                tree.config.clone()
            ).await 
                .map(|diff_entries: Vec<DiffEntry>| {
                    let js_result_array = JsArray::new_with_length(diff_entries.len() as u32);
                    for (index, entry) in diff_entries.iter().enumerate() {
                        let js_entry_obj = Object::new();
                        let _ = Reflect::set( &js_entry_obj, &JsValue::from_str("key"), &JsValue::from(JsUint8Array::from(entry.key.as_slice())) );
                        if let Some(ref lv) = entry.left_value { let _ = Reflect::set( &js_entry_obj, &JsValue::from_str("leftValue"), &JsValue::from(JsUint8Array::from(lv.as_slice())) ); }
                        if let Some(ref rv) = entry.right_value { let _ = Reflect::set( &js_entry_obj, &JsValue::from_str("rightValue"), &JsValue::from(JsUint8Array::from(rv.as_slice())) ); }
                        js_result_array.set(index as u32, JsValue::from(js_entry_obj));
                    }
                    JsValue::from(js_result_array) 
                })
                .map_err(prolly_error_to_jsvalue) 
        };

        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = triggerGc)]
    pub fn trigger_gc(&self, live_root_hashes_js: &JsArray) -> Promise {
        let mut live_root_hashes_rust: Vec<Hash> = Vec::new();

        for i in 0..live_root_hashes_js.length() {
            let val = live_root_hashes_js.get(i);
            if let Some(js_uint8_array) = val.dyn_ref::<JsUint8Array>() {
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
            let tree = tree_clone.lock().await; 
            tree.gc(&live_root_hashes_rust).await
                .map(|count| JsValue::from_f64(count as f64)) 
                .map_err(prolly_error_to_jsvalue)
        };

        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = "getTreeConfig")]
    pub fn get_tree_config(&self) -> Promise { 
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree = tree_clone.lock().await;
            match serde_wasm_bindgen::to_value(&tree.config) {
                Ok(js_val) => Ok(js_val),
                Err(e) => Err(JsValue::from_str(&format!("Failed to serialize config: {}", e))),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    // --- THIS IS THE UPDATED scan_items METHOD ---
    #[wasm_bindgen( 
        js_name = scanItems,
    )]
    pub fn scan_items(
        &self,
        options: ScanOptions, // Parameter name changed from scan_args_js to options for clarity
    ) -> Promise {        
        // Using gloo_console for logging. Ensure it's a dependency and initialized if used.
        // For example, in your main lib or a setup function: `wasm_logger::init(wasm_logger::Config::default());`
        // gloo_console::debug!(format!("Rust scan_items: Received raw options: {:?}", options));

        let core_scan_args: core_tree_types::ScanArgs =
            if options.is_undefined() || options.is_null() {
                core_tree_types::ScanArgs::default()
            } else {
                match serde_wasm_bindgen::from_value(options.clone()) { // .clone() if options is used after this for e.g. logging
                    Ok(args) => args,
                    Err(e) => {
                        let err_msg = format!("Failed to parse scan arguments: {}. Ensure the object matches the ScanOptions interface.", e);
                        gloo_console::error!(&err_msg); 
                        return Promise::reject(&JsValue::from_str(&err_msg));
                    }
                }
            };
        
        gloo_console::debug!(format!("Rust scan_items: Parsed core_scan_args: {:?}", core_scan_args));

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let tree_guard = tree_clone.lock().await;
            match tree_guard.scan(core_scan_args).await { 
                Ok(core_scan_page) => { 
                    let wasm_scan_page = WasmScanPage::from(core_scan_page);
                    Ok(JsValue::from(wasm_scan_page)) 
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
            let tree_guard = tree_clone.lock().await; 
            match tree_guard.count_all_items().await {
            Ok(count) => Ok(JsValue::from_f64(count as f64)), 
            Err(e) => Err(prolly_error_to_jsvalue(e)),
            }
        };
        wasm_bindgen_futures::future_to_promise(future)
    }
}