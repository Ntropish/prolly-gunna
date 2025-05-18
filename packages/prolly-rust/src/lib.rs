// prolly-rust/src/lib.rs

#![cfg(target_arch = "wasm32")]

use std::sync::Arc;
use wasm_bindgen::prelude::*;
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
use crate::wasm_bridge::WasmScanPage;       // For the WasmScanPage return type (used in scan_items)
use serde_wasm_bindgen;                    // For from_value / to_value

use crate::tree::ProllyTree;
use crate::store::InMemoryStore;
use crate::common::{TreeConfig, Key, Value, Hash};
use crate::error::ProllyError;
use crate::diff::DiffEntry as CoreDiffEntry; // Alias to avoid conflict if DiffEntry is also defined in TS section

// Helper to convert ProllyError to JsValue for Promise rejections
fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

// --- TypeScript Custom Section ---
// Import the TypeScript definitions from an external file.
// Adjust path if your .ts file is located elsewhere relative to lib.rs
const PROLLY_TREE_TS_DEFS: &str = include_str!("prolly_tree_types.ts");

#[wasm_bindgen(typescript_custom_section)]
const TS_APPEND_CONTENT: &'static str = PROLLY_TREE_TS_DEFS;

#[wasm_bindgen]
extern "C" {
    // Types for function parameters that are complex objects
    #[wasm_bindgen(typescript_type = "TreeConfigOptions")]
    pub type TreeConfigOptions;

    #[wasm_bindgen(typescript_type = "ScanOptions")]
    pub type ScanOptions;

    #[wasm_bindgen(typescript_type = "BatchItem[]")]
    pub type BatchItemsArray; // Used for insert_batch's items parameter

    #[wasm_bindgen(typescript_type = "Uint8Array[]")]
    pub type Uint8ArrayArray; // Used for trigger_gc's live_root_hashes parameter

    // Typed Promises for function return types
    // These map to the `Promise<ResolvedType>` in TypeScript.
    #[wasm_bindgen(typescript_type = "Promise<GetFnReturn>")]
    pub type PromiseGetFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<InsertFnReturn>")]
    pub type PromiseInsertFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<InsertBatchFnReturn>")]
    pub type PromiseInsertBatchFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<DeleteFnReturn>")]
    pub type PromiseDeleteFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<CommitFnReturn>")]
    pub type PromiseCommitFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<GetRootHashFnReturn>")]
    pub type PromiseGetRootHashFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<ExportChunksFnReturn>")]
    pub type PromiseExportChunksFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<DiffRootsFnReturn>")]
    pub type PromiseDiffRootsFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<TriggerGcFnReturn>")]
    pub type PromiseTriggerGcFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<GetTreeConfigFnReturn>")]
    pub type PromiseGetTreeConfigFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<ScanItemsFnReturn>")]
    pub type PromiseScanItemsFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<CountAllItemsFnReturn>")]
    pub type PromiseCountAllItemsFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<CursorNextReturn>")]
    pub type PromiseCursorNextReturn;
}
// --- End TypeScript Custom Section ---


/// Public wrapper for ProllyTree exported to JavaScript.
#[wasm_bindgen]
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
    pub fn next(&self) -> PromiseCursorNextReturn {
        let cursor_clone = Arc::clone(&self.inner);
        let future = async move {
            let mut cursor_guard = cursor_clone.lock().await;
            // Using default scan args for cursor iteration for now.
            // Consider if cursor needs its own scan args or if this is sufficient.
            let default_core_args = core_tree_types::ScanArgs::default();
            match cursor_guard.next_in_scan(&default_core_args).await {
                Ok(Some((key, value))) => {
                    let key_js = JsUint8Array::from(&key[..]);
                    let val_js = JsUint8Array::from(&value[..]);
                    let js_array_val = JsArray::new_with_length(2);
                    js_array_val.set(0, JsValue::from(key_js));
                    js_array_val.set(1, JsValue::from(val_js));

                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::FALSE)
                        .map_err(|e| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Failed to set 'done': {:?}", e))))?;
                    Reflect::set(&result_obj, &JsValue::from_str("value"), &JsValue::from(js_array_val))
                        .map_err(|e| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Failed to set 'value': {:?}", e))))?;
                    Ok(JsValue::from(result_obj))
                }
                Ok(None) => {
                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &JsValue::from_str("done"), &JsValue::TRUE)
                        .map_err(|e| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Failed to set 'done': {:?}", e))))?;
                    // 'value' can be omitted or set to undefined when done is true, as per typical iterator protocols.
                    // Reflect::set(&result_obj, &JsValue::from_str("value"), &JsValue::UNDEFINED)?;
                    Ok(JsValue::from(result_obj))
                }
                Err(e) => Err(prolly_error_to_jsvalue(e)),
            }
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
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
        tree_config_options: Option<TreeConfigOptions>, // MODIFIED: Now Option<TreeConfigOptions>
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
        
        let config: TreeConfig = match tree_config_options {
            Some(options_js_val) => {
                // options_js_val is of type TreeConfigOptions (which is a JsValue facade)
                // We need to convert it to a JsValue to use with from_value
                let js_val_ref: &JsValue = options_js_val.as_ref(); // Convert TreeConfigOptions to &JsValue
                if js_val_ref.is_undefined() || js_val_ref.is_null() {
                    TreeConfig::default()
                } else {
                    match serde_wasm_bindgen::from_value(js_val_ref.clone()) {
                        Ok(cfg) => cfg,
                        Err(e) => {
                            // Using gloo_console from your previous lib.rs setup
                            gloo_console::warn!(&format!("Failed to deserialize TreeConfigOptions: {}. Using default.", e));
                            TreeConfig::default()
                        }
                    }
                }
            }
            None => {
                // Argument was omitted by the JS caller
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
                    WasmProllyTree { inner: Arc::new(tokio::sync::Mutex::new(tree)) }.into()
                })
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen]
    pub fn get(&self, key_js: &JsUint8Array) -> PromiseGetFnReturn {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.get(&key).await
                .map(|opt_val| opt_val.map_or(JsValue::NULL, |v| JsValue::from(JsUint8Array::from(&v[..]))))
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen]
    pub fn insert(&self, key_js: &JsUint8Array, value_js: &JsUint8Array) -> PromiseInsertFnReturn {
        let key: Key = key_js.to_vec();
        let value: Value = value_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.insert(key, value).await
                .map(|_| JsValue::UNDEFINED)
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = insertBatch)]
    pub fn insert_batch(&self, items_js_val: &JsValue) -> PromiseInsertBatchFnReturn {
        let items_array = match items_js_val.dyn_ref::<JsArray>() {
            Some(arr) => arr,
            None => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str("insertBatch expects an array."))).into(),
        };
        let mut items_rust: Vec<(Key, Value)> = Vec::with_capacity(items_array.length() as usize);
        for i in 0..items_array.length() {
            let pair_val = items_array.get(i);
            let pair_array = match pair_val.dyn_ref::<JsArray>() {
                Some(pa) if pa.length() == 2 => pa,
                Some(_) => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("Item at index {} in batch is not a [key, value] pair.", i)))).into(),
                None => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("Item at index {} in batch is not an array.", i)))).into(),
            };

            // Check key and value types, using the combined error message expected by the test.
            let key_js_val = pair_array.get(0);
            let value_js_val = pair_array.get(1);

            if !key_js_val.is_instance_of::<JsUint8Array>() || !value_js_val.is_instance_of::<JsUint8Array>() {
                return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("Item at index {} in batch has non-Uint8Array key or value.",i)))).into();
            }

            // At this point, we know they are JsUint8Array, so we can safely cast.
            let key_u8 = key_js_val.dyn_into::<JsUint8Array>().unwrap_throw().to_vec();
            let value_u8 = value_js_val.dyn_into::<JsUint8Array>().unwrap_throw().to_vec();
            
            items_rust.push((key_u8, value_u8));
        }

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.insert_batch(items_rust).await
                .map(|_| JsValue::UNDEFINED).map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }
    
    #[wasm_bindgen]
    pub fn delete(&self, key_js: &JsUint8Array) -> PromiseDeleteFnReturn {
        let key: Key = key_js.to_vec();
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.delete(&key).await 
                .map(JsValue::from_bool).map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen]
    pub fn commit(&self) -> PromiseCommitFnReturn {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.commit().await
                .map(|opt_hash| opt_hash.map_or(JsValue::NULL, |h| JsValue::from(JsUint8Array::from(&h[..]))))
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }
    
    #[wasm_bindgen(js_name = "getRootHash")]
    pub fn get_root_hash(&self) -> PromiseGetRootHashFnReturn {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            Ok(tree_clone.lock().await.get_root_hash().map_or(JsValue::NULL, |h| JsValue::from(JsUint8Array::from(&h[..]))))
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = "exportChunks")]
    pub fn export_chunks(&self) -> PromiseExportChunksFnReturn {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let all_chunks = tree_clone.lock().await.store.get_all_chunks_for_test().await;
            let js_map = JsMap::new();
            all_chunks.into_iter().for_each(|(h,d)| {
                js_map.set(&JsUint8Array::from(&h[..]).into(), &JsUint8Array::from(&d[..]).into());
            });
            Ok(JsValue::from(js_map))
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = newWithConfig)]
    pub fn new_with_config(target_fanout: usize, min_fanout: usize) -> Result<WasmProllyTree, JsValue> {
        let df = TreeConfig::default(); 
        let cfg = TreeConfig { target_fanout, min_fanout, cdc_min_size: df.cdc_min_size, cdc_avg_size: df.cdc_avg_size, cdc_max_size: df.cdc_max_size, max_inline_value_size: df.max_inline_value_size };
        if cfg.min_fanout==0||cfg.target_fanout<cfg.min_fanout*2||cfg.target_fanout==0 {
             return Err(JsValue::from_str("Invalid fanout."));
        }
        Ok(Self { inner: Arc::new(tokio::sync::Mutex::new(ProllyTree::new(Arc::new(InMemoryStore::new()), cfg))) })
    }

    #[wasm_bindgen(js_name = cursorStart)]
    pub fn cursor_start(&self) -> Promise {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
             tree_clone.lock().await.cursor_start().await
                .map(|c| WasmProllyTreeCursor{inner:Arc::new(tokio::sync::Mutex::new(c))}.into())
                .map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen]
    pub fn seek(&self, key_js: &JsUint8Array) -> Promise {
         let key: Key = key_js.to_vec();
         let tree_clone = Arc::clone(&self.inner);
         let future = async move {
              tree_clone.lock().await.seek(&key).await
                 .map(|c| WasmProllyTreeCursor{inner:Arc::new(tokio::sync::Mutex::new(c))}.into())
                 .map_err(prolly_error_to_jsvalue)
         };
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = diffRoots)]
    pub fn diff_roots( &self, root_h_left_js: Option<JsUint8Array>, root_h_right_js: Option<JsUint8Array>) -> PromiseDiffRootsFnReturn {
        let parse_hash = |h_js: Option<JsUint8Array>, name: &str| -> Result<Option<Hash>, JsValue> {
            match h_js {
                Some(js_arr) if js_arr.length()==32 => { let mut h=[0u8;32]; js_arr.copy_to(&mut h); Ok(Some(h)) }
                Some(js_arr) => Err(JsValue::from_str(&format!("Invalid {} length: {}, must be 32 bytes or null.", name, js_arr.length()))),
                None => Ok(None),
            }
        };
        let (h_left, h_right) = match (parse_hash(root_h_left_js,"root_hash_left"), parse_hash(root_h_right_js,"root_hash_right")) {
            (Ok(l), Ok(r)) => (l,r),
            (Err(e), _) | (_, Err(e)) => return wasm_bindgen::JsValue::from(Promise::reject(&e)).into(),
        };
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            let config_clone = tree_clone.lock().await.config.clone(); // Clone config
            let store_clone = Arc::clone(&tree_clone.lock().await.store); // Clone store Arc
            crate::diff::diff_trees(h_left, h_right, store_clone, config_clone).await // Use CoreDiffEntry
                .map(|diff_entries: Vec<CoreDiffEntry>| { 
                    diff_entries.iter().map(|entry| {
                        let obj = Object::new();
                        Reflect::set(&obj, &"key".into(), &JsUint8Array::from(entry.key.as_slice()).into()).unwrap_or_default();
                        if let Some(ref lv)=entry.left_value { Reflect::set(&obj, &"leftValue".into(), &JsUint8Array::from(lv.as_slice()).into()).unwrap_or_default(); }
                        if let Some(ref rv)=entry.right_value { Reflect::set(&obj, &"rightValue".into(), &JsUint8Array::from(rv.as_slice()).into()).unwrap_or_default(); }
                        JsValue::from(obj)
                    }).collect::<JsArray>().into()
                }).map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = triggerGc)]
    pub fn trigger_gc(&self, live_hashes_js_val: &JsValue) -> PromiseTriggerGcFnReturn {
        let live_hashes_array = match live_hashes_js_val.dyn_ref::<JsArray>() {
            Some(arr) => arr,
            None => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str("triggerGc expects an array."))).into(),
        };
        let mut live_hashes_rust: Vec<Hash> = Vec::new();
        for i in 0..live_hashes_array.length() {
            match live_hashes_array.get(i).dyn_ref::<JsUint8Array>() {
                Some(js_u8) if js_u8.length()==32 => { let mut h=[0u8;32]; js_u8.copy_to(&mut h); live_hashes_rust.push(h); }
                Some(js_u8) => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("Hash at index {} invalid length: {}.",i,js_u8.length())))).into(),
                _ => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("Hash at index {} not Uint8Array.",i)))).into(),
            }
        }
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.gc(&live_hashes_rust).await
                .map(|c| JsValue::from_f64(c as f64)).map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = "getTreeConfig")]
    pub fn get_tree_config(&self) -> PromiseGetTreeConfigFnReturn { 
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            serde_wasm_bindgen::to_value(&tree_clone.lock().await.config)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize TreeConfig: {}", e)))
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = scanItems)]
    pub fn scan_items( &self, options: ScanOptions ) -> PromiseScanItemsFnReturn {        
        let core_scan_args: core_tree_types::ScanArgs = if options.is_undefined() || options.is_null() {
            core_tree_types::ScanArgs::default()
        } else {
            match serde_wasm_bindgen::from_value(options.clone()) { // options is JsValue
                Ok(args) => args,
                Err(e) => return wasm_bindgen::JsValue::from(Promise::reject(&JsValue::from_str(&format!("ScanOptions parse error: {}",e)))).into(),
            }
        };
        
        gloo_console::debug!(format!("Rust scan_items: Parsed core_scan_args: {:?}", core_scan_args));

        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.scan(core_scan_args).await
                .map_err(prolly_error_to_jsvalue)
                .map(|core_scan_page| {
                    let wasm_scan_page_bridge = crate::wasm_bridge::WasmScanPage::from(core_scan_page);
                    // WasmScanPage is #[wasm_bindgen], so JsValue::from() is correct.
                    JsValue::from(wasm_scan_page_bridge)
                })
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = countAllItems)]
    pub fn count_all_items(&self) -> PromiseCountAllItemsFnReturn {
        let tree_clone = Arc::clone(&self.inner);
        let future = async move {
            tree_clone.lock().await.count_all_items().await
                .map(|c| JsValue::from_f64(c as f64)).map_err(prolly_error_to_jsvalue)
        };
        wasm_bindgen::JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

}