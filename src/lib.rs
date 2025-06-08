// src/lib.rs

#![cfg(target_arch = "wasm32")]

use std::sync::Arc;
use wasm_bindgen::prelude::*;
use js_sys::{Promise, Uint8Array as JsUint8Array, Map as JsMap, Object, Reflect, Array as JsArray};
use wasm_bindgen_futures::spawn_local;
use futures::channel::oneshot;

// Declare all modules
pub mod common;
pub mod error;
pub mod store;
pub mod node;
pub mod chunk;
pub mod tree;
pub mod diff;
pub mod gc;
pub mod wasm_bridge;
pub mod platform; 

use crate::store::file_io_v2::{write_prly_tree_v2, read_prly_tree_v2};
use crate::tree::types as core_tree_types;
use crate::tree::ProllyTree;
use crate::store::{ChunkStore, InMemoryStore};
use crate::common::{TreeConfig, Hash};
use crate::error::ProllyError;


fn prolly_error_to_jsvalue(err: ProllyError) -> JsValue {
    JsValue::from_str(&format!("ProllyError: {}", err))
}

macro_rules! async_to_promise {
    ($self:ident, |$tree_pattern:pat_param| $async_block:expr) => {{
        let tree_clone = Arc::clone(&$self.inner);
        let (tx, rx) = oneshot::channel();
        spawn_local(async move {
            let $tree_pattern = tree_clone.lock().await;
            let result: Result<JsValue, JsValue> = (async { $async_block }).await;
            let _ = tx.send(result);
        });
        async move {
            match rx.await {
                Ok(res) => res,
                Err(_) => Err(prolly_error_to_jsvalue(ProllyError::InternalError("oneshot channel was canceled".to_string()))),
            }
        }
    }};
}


#[wasm_bindgen(typescript_custom_section)]
const TS_APPEND_CONTENT: &'static str = include_str!("prolly_tree_types.ts");
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "TreeConfigOptions")]
    pub type TreeConfigOptions;
    #[wasm_bindgen(typescript_type = "ScanOptions")]
    pub type ScanOptions;
    #[wasm_bindgen(typescript_type = "HierarchyScanOptions")]
    pub type HierarchyScanOptions;
    #[wasm_bindgen(typescript_type = "Promise<GetFnReturn>")]
    pub type PromiseGetFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<InsertFnReturn>")]
    pub type PromiseInsertFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<InsertBatchFnReturn>")]
    pub type PromiseInsertBatchFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<DeleteFnReturn>")]
    pub type PromiseDeleteFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<CheckoutFnReturn>")]
    pub type PromiseCheckoutFnReturn;
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
    #[wasm_bindgen(typescript_type = "Promise<HierarchyScanFnReturn>")]
    pub type PromiseHierarchyScanReturn;
    #[wasm_bindgen(typescript_type = "Promise<ExportTreeToFileFnReturn>")]
    pub type PromiseExportTreeToFileFnReturn;
    #[wasm_bindgen(typescript_type = "Promise<LoadTreeFromFileBytesFnReturn>")]
    pub type PromiseLoadTreeFromFileBytesFnReturn;
}

#[wasm_bindgen(js_name = "PTree")]
#[derive(Clone)]
pub struct PTree {
    inner: Arc<tokio::sync::Mutex<ProllyTree<InMemoryStore>>>,
}

#[wasm_bindgen(js_name = "PTreeCursor")]
#[derive(Clone)]
pub struct PTreeCursor {
    inner: Arc<tokio::sync::Mutex<tree::Cursor<InMemoryStore>>>,
}

// All methods are now implemented with the corrected macro and return types.
// This section should be copy-pasted in its entirety.
#[wasm_bindgen(js_class = "PTreeCursor")]
impl PTreeCursor {
    #[wasm_bindgen]
    pub fn next(&self) -> PromiseCursorNextReturn {
        let cursor_clone = Arc::clone(&self.inner);
        let (tx, rx) = oneshot::channel();

        spawn_local(async move {
            let mut cursor_guard = cursor_clone.lock().await;
            let result = cursor_guard.next().await;
            let _ = tx.send(result);
        });
        
        let future = async move {
            match rx.await {
                Ok(Ok(Some((key, value)))) => {
                    let key_js = JsUint8Array::from(key.as_slice());
                    let val_js = JsUint8Array::from(value.as_slice());
                    let pair = JsArray::new_with_length(2);
                    pair.set(0, key_js.into());
                    pair.set(1, val_js.into());
                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &"done".into(), &false.into())?;
                    Reflect::set(&result_obj, &"value".into(), &pair.into())?;
                    Ok(result_obj.into())
                },
                Ok(Ok(None)) => {
                    let result_obj = Object::new();
                    Reflect::set(&result_obj, &"done".into(), &true.into())?;
                    Ok(result_obj.into())
                },
                Ok(Err(e)) => Err(prolly_error_to_jsvalue(e)),
                Err(_) => Err(prolly_error_to_jsvalue(ProllyError::InternalError("oneshot channel was canceled".to_string()))),
            }
        };
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }
}


#[wasm_bindgen(js_class = "PTree")]
impl PTree {
    #[wasm_bindgen(constructor)]
    pub fn new(options: Option<TreeConfigOptions>) -> Result<PTree, JsValue> {
        let config = options.and_then(|opts| serde_wasm_bindgen::from_value(opts.into()).ok()).unwrap_or_default();
        let store = Arc::new(InMemoryStore::new());
        let tree = ProllyTree::new(store, config);
        Ok(Self { inner: Arc::new(tokio::sync::Mutex::new(tree)) })
    }

    #[wasm_bindgen(js_name = "load")]
    pub fn load(
        root_hash_js: Option<JsUint8Array>,
        chunks_js: &JsMap,
        tree_config_options: Option<TreeConfigOptions>,
    ) -> PromiseLoadTreeFromFileBytesFnReturn {
        let store_result = InMemoryStore::from_js_map(chunks_js);
        let root_h_opt = root_hash_js.map(|arr| { let mut h: Hash = [0; 32]; arr.copy_to(&mut h); h });
        let config: TreeConfig = tree_config_options
            .and_then(|opts| serde_wasm_bindgen::from_value(opts.into()).ok())
            .unwrap_or_default();

        let future = async move {
            let store = Arc::new(store_result?);
            let tree = match root_h_opt {
                Some(h) => ProllyTree::from_root_hash(h, store, config).await?,
                None => ProllyTree::new(store, config),
            };
            Ok(PTree { inner: Arc::new(tokio::sync::Mutex::new(tree)) }.into())
        };

        let promise = wasm_bindgen_futures::future_to_promise(async { future.await.map_err(prolly_error_to_jsvalue) });
        JsValue::from(promise).into()
    }

    #[wasm_bindgen]
    pub fn get(&self, key_js: &JsUint8Array) -> PromiseGetFnReturn {
        let key = key_js.to_vec();
        let future = async_to_promise!(self, |tree| {
            tree.get(&key).await
                .map(|opt_val| opt_val.map_or(JsValue::NULL, |v| JsUint8Array::from(&v[..]).into()))
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }


    #[wasm_bindgen]
    pub fn insert(&self, key_js: &JsUint8Array, value_js: &JsUint8Array) -> PromiseInsertFnReturn {
        let key = key_js.to_vec();
        let value = value_js.to_vec();
        let future = async_to_promise!(self, |mut tree| {
            tree.insert(key, value).await
                .map(|_| JsValue::UNDEFINED)
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }
    
    #[wasm_bindgen(js_name = insertBatch)]
    pub fn insert_batch(&self, items_js_val: &JsValue) -> PromiseInsertBatchFnReturn {
        let items_array: JsArray = match items_js_val.dyn_ref::<JsArray>() {
            Some(arr) => arr.clone(),
            None => return JsValue::from(Promise::reject(&JsValue::from_str("insertBatch expects an array."))).into(),
        };
        let future = async_to_promise!(self, |mut tree| {
            let mut items_rust = Vec::with_capacity(items_array.length() as usize);
            for i in 0..items_array.length() {
                let pair_val = items_array.get(i);
                // This validation returns Result<_, JsValue> which is correct
                let pair_array = pair_val.dyn_into::<JsArray>().map_err(|_| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Item at index {} is not an array", i))))?;
                if pair_array.length() != 2 { return Err(prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Item at index {} is not a pair", i)))); }

                let key_u8 = pair_array.get(0).dyn_into::<JsUint8Array>().map_err(|_| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Key at index {} is not a Uint8Array", i))))?.to_vec();
                let value_u8 = pair_array.get(1).dyn_into::<JsUint8Array>().map_err(|_| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Value at index {} is not a Uint8Array", i))))?.to_vec();
                items_rust.push((key_u8, value_u8));
            }
            
            // FIX IS HERE: map the ProllyError to a JsValue to match the block's return type
            tree.insert_batch(items_rust).await
                .map(|_| JsValue::UNDEFINED)
                .map_err(prolly_error_to_jsvalue) // Add this line
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen]
    pub fn delete(&self, key_js: &JsUint8Array) -> PromiseDeleteFnReturn {
        let key = key_js.to_vec();
        let future = async_to_promise!(self, |mut tree| {
            tree.delete(&key).await.map(JsValue::from).map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen]
    pub fn checkout(&self, hash_js: Option<JsUint8Array>) -> PromiseCheckoutFnReturn {
        let hash_opt = hash_js.map(|h| { let mut hash = [0;32]; h.copy_to(&mut hash); hash });
        let future = async_to_promise!(self, |mut tree| {
            tree.checkout(hash_opt).await.map(|_| JsValue::UNDEFINED).map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = "getRootHash")]
    pub fn get_root_hash(&self) -> PromiseGetRootHashFnReturn {
        let future = async_to_promise!(self, |tree| {
            Ok(tree.get_root_hash().map_or(JsValue::NULL, |h| JsUint8Array::from(&h[..]).into()))
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = "exportChunks")]
    pub fn export_chunks(&self) -> PromiseExportChunksFnReturn {
        let future = async_to_promise!(self, |tree| {
            let all_chunks = tree.store.get_all_chunks_for_test().await;
            let js_map = JsMap::new();
            for (h, d) in all_chunks {
                js_map.set(&JsUint8Array::from(&h[..]).into(), &JsUint8Array::from(&d[..]).into());
            }
            Ok(js_map.into())
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = cursorStart)]
    pub fn cursor_start(&self) -> Promise {
        let future = async_to_promise!(self, |tree| {
             tree.cursor_start().await
                 .map(|c| PTreeCursor{inner:Arc::new(tokio::sync::Mutex::new(c))}.into())
                 .map_err(prolly_error_to_jsvalue)
        });
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen]
    pub fn seek(&self, key_js: &JsUint8Array) -> Promise {
        let key = key_js.to_vec();
        let future = async_to_promise!(self, |tree| {
             tree.seek(&key).await
                .map(|c| PTreeCursor{inner:Arc::new(tokio::sync::Mutex::new(c))}.into())
                .map_err(prolly_error_to_jsvalue)
        });
        wasm_bindgen_futures::future_to_promise(future)
    }

    #[wasm_bindgen(js_name = diffRoots)]
    pub fn diff_roots(&self, _root_h_left_js: Option<JsUint8Array>, root_h_right_js: Option<JsUint8Array>) -> PromiseDiffRootsFnReturn {
        let h_right = root_h_right_js.map(|arr| { let mut h = [0;32]; arr.copy_to(&mut h); h });
        
        let future = async_to_promise!(self, |tree| {
            // FIX: Add `.map_err(prolly_error_to_jsvalue)` before the `?`
            let diffs = tree.diff(h_right).await.map_err(prolly_error_to_jsvalue)?;
            
            let res_array = JsArray::new_with_length(diffs.len() as u32);
            for (i, entry) in diffs.iter().enumerate() {
                let obj = Object::new();
                Reflect::set(&obj, &"key".into(), &JsUint8Array::from(entry.key.as_slice()).into())?;
                if let Some(ref lv) = entry.left_value { Reflect::set(&obj, &"leftValue".into(), &JsUint8Array::from(lv.as_slice()).into())?; }
                if let Some(ref rv) = entry.right_value { Reflect::set(&obj, &"rightValue".into(), &JsUint8Array::from(rv.as_slice()).into())?; }
                res_array.set(i as u32, obj.into());
            }
            Ok(res_array.into())
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = triggerGc)]
    pub fn trigger_gc(&self, live_hashes_js_val: &JsValue) -> PromiseTriggerGcFnReturn {
        let live_hashes_array: JsArray = match live_hashes_js_val.dyn_ref::<JsArray>() {
            Some(arr) => arr.clone(),
            None => return JsValue::from(Promise::reject(&JsValue::from_str("triggerGc expects an array."))).into(),
        };

        let future = async_to_promise!(self, |tree| {
            let mut live_hashes_rust: Vec<Hash> = Vec::new();
            for i in 0..live_hashes_array.length() {
                 let js_u8: JsUint8Array = live_hashes_array.get(i).dyn_into().map_err(|_| prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Hash at index {} not Uint8Array.", i))))?;
                 if js_u8.length() != 32 { return Err(prolly_error_to_jsvalue(ProllyError::JsBindingError(format!("Hash at index {} invalid length: {}.", i, js_u8.length())))); }
                 let mut h=[0u8;32];
                 js_u8.copy_to(&mut h);
                 live_hashes_rust.push(h);
            }
            tree.gc(&live_hashes_rust).await
                .map(|c| JsValue::from_f64(c as f64))
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = "getTreeConfig")]
    pub fn get_tree_config(&self) -> PromiseGetTreeConfigFnReturn { 
        let future = async_to_promise!(self, |tree| {
            serde_wasm_bindgen::to_value(&tree.config)
                .map_err(|e| prolly_error_to_jsvalue(ProllyError::Serialization(e.to_string())))
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = scanItems)]
    pub fn scan_items( &self, options: ScanOptions ) -> PromiseScanItemsFnReturn {         
        let core_scan_args_res: Result<core_tree_types::ScanArgs, _> = serde_wasm_bindgen::from_value(options.into());
        let future = async_to_promise!(self, |tree| {
             let core_scan_args = core_scan_args_res.map_err(|e| prolly_error_to_jsvalue(ProllyError::JsBindingError(e.to_string())))?;
             tree.scan(core_scan_args).await
                .map(|core_scan_page| wasm_bridge::ScanPage::from(core_scan_page).into())
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = countAllItems)]
    pub fn count_all_items(&self) -> PromiseCountAllItemsFnReturn {
        let future = async_to_promise!(self, |tree| {
            tree.count_all_items().await
                .map(|c| JsValue::from_f64(c as f64))
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = hierarchyScan)]
    pub fn hierarchy_scan(&self, options: Option<HierarchyScanOptions>) -> PromiseHierarchyScanReturn {
        let core_scan_args: core_tree_types::HierarchyScanArgs = options
            .and_then(|opts| serde_wasm_bindgen::from_value(opts.into()).ok())
            .unwrap_or_default();

        let future = async_to_promise!(self, |tree| {
            tree.hierarchy_scan(core_scan_args).await
                .map(|core_page| wasm_bridge::HierarchyScanPage::from(core_page).into())
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = saveTreeToFileBytes)]
    pub fn save_tree_to_file_bytes(&self, description: Option<String>) -> PromiseExportTreeToFileFnReturn {
        let future = async_to_promise!(self, |tree| {
            let root_hash = tree.get_root_hash();
            let tree_config = tree.config.clone();
            let chunks_map_rust = tree.store.get_all_chunks_for_test().await;

            write_prly_tree_v2(root_hash, &tree_config, &chunks_map_rust, description)
                .map(|file_bytes| JsUint8Array::from(&file_bytes[..]).into())
                .map_err(prolly_error_to_jsvalue)
        });
        JsValue::from(wasm_bindgen_futures::future_to_promise(future)).into()
    }

    #[wasm_bindgen(js_name = loadTreeFromFileBytes)]
    pub fn load_tree_from_file_bytes(file_bytes_js: &JsUint8Array) -> PromiseLoadTreeFromFileBytesFnReturn {
        let file_bytes = file_bytes_js.to_vec();
        
        let future = async move {
            let (root_hash_opt, tree_config, chunks_map_rust, _description) = read_prly_tree_v2(&file_bytes)?;
            let store_instance = InMemoryStore::new();
            
            for (expected_hash, data) in chunks_map_rust {
                let actual_hash = store_instance.put(data).await?;
                if actual_hash != expected_hash {
                    return Err(ProllyError::InternalError("Hash mismatch on load".to_string()));
                }
            }

            let store_arc = Arc::new(store_instance);
            let tree = if let Some(root_hash) = root_hash_opt {
                ProllyTree::from_root_hash(root_hash, Arc::clone(&store_arc), tree_config).await?
            } else {
                ProllyTree::new(Arc::clone(&store_arc), tree_config)
            };

            Ok(PTree { inner: Arc::new(tokio::sync::Mutex::new(tree)) }.into())
        };

        let promise_future = async move {
            future.await.map_err(prolly_error_to_jsvalue)
        };

        // FIX: Pass the `promise_future` here instead of the original `future`.
        JsValue::from(wasm_bindgen_futures::future_to_promise(promise_future)).into()
    }
}