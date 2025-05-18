// prolly-rust/src/wasm_bridge.rs
use crate::tree::types as core_tree_types;
use crate::common::{Key, Value}; // Key and Value are Vec<u8>
use wasm_bindgen::prelude::*;
use js_sys::{Uint8Array as JsUint8Array, Array as JsArray, BigInt as JsBigInt};
use serde::Deserialize; // For the helper struct
use serde_wasm_bindgen;


// Helper struct for deserializing JsValue with all fields optional
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JsScanArgsInput {
    #[serde(default)] start_bound: Option<Key>,
    #[serde(default)] end_bound: Option<Key>,
    #[serde(default)] start_inclusive: Option<bool>,
    #[serde(default)] end_inclusive: Option<bool>,
    #[serde(default)] reverse: Option<bool>,
    #[serde(default)] offset: Option<u64>, // Serde handles JS number/bigint to Option<u64>
    #[serde(default)] limit: Option<usize>,
}


#[wasm_bindgen]
#[derive(Debug, Clone)] // Not deriving Serde, this is constructed from core_tree_types::ScanPage
pub struct WasmScanPage {
    // Internal fields to hold data. These will be populated from core_tree_types::ScanPage.
    items: Vec<(Key, Value)>, // This specific field needs a custom getter for JS
    has_next_page: bool,
    has_previous_page: bool,
    next_page_cursor: Option<Key>,
    previous_page_cursor: Option<Key>,
}

#[wasm_bindgen]
impl WasmScanPage {
    // Note: No #[wasm_bindgen(constructor)] here, as WasmScanPage is created from Rust logic.

    #[wasm_bindgen(getter)]
    pub fn items(&self) -> JsArray {
        let js_items_array = JsArray::new_with_length(self.items.len() as u32);
        for (i, (k, v)) in self.items.iter().enumerate() {
            let key_js = JsUint8Array::from(k.as_slice());
            let val_js = JsUint8Array::from(v.as_slice());
            let pair_array = JsArray::new_with_length(2);
            pair_array.set(0, JsValue::from(key_js));
            pair_array.set(1, JsValue::from(val_js));
            js_items_array.set(i as u32, JsValue::from(pair_array));
        }
        js_items_array
    }

    #[wasm_bindgen(getter = hasNextPage)]
    pub fn has_next_page(&self) -> bool { self.has_next_page }

    #[wasm_bindgen(getter = hasPreviousPage)]
    pub fn has_previous_page(&self) -> bool { self.has_previous_page }

    #[wasm_bindgen(getter = nextPageCursor)]
    pub fn next_page_cursor(&self) -> Option<JsUint8Array> {
        self.next_page_cursor.as_ref().map(|v| JsUint8Array::from(v.as_slice()))
    }

    #[wasm_bindgen(getter = previousPageCursor)]
    pub fn previous_page_cursor(&self) -> Option<JsUint8Array> {
        self.previous_page_cursor.as_ref().map(|v| JsUint8Array::from(v.as_slice()))
    }
}

// Conversion from core_tree_types::ScanPage to WasmScanPage
impl From<core_tree_types::ScanPage> for WasmScanPage {
    fn from(core_page: core_tree_types::ScanPage) -> Self {
        Self {
            items: core_page.items,
            has_next_page: core_page.has_next_page,
            has_previous_page: core_page.has_previous_page,
            next_page_cursor: core_page.next_page_cursor,
            previous_page_cursor: core_page.previous_page_cursor,
        }
    }
}

