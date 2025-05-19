// prolly-rust/src/wasm_bridge.rs
use crate::tree::types as core_tree_types;
use crate::common::{Key, Value}; // Key and Value are Vec<u8>
use wasm_bindgen::prelude::*;
use js_sys::{Object, Reflect, Uint8Array as JsUint8Array, Array as JsArray};
use crate::WasmProllyTree; 

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



// We'll convert HierarchyItem to a generic JsValue (Object) in Rust
// as enums with data are tricky with wasm_bindgen directly for complex types.
// The TS type above will guide the JS consumer.

fn hierarchy_item_to_jsvalue(item: core_tree_types::HierarchyItem) -> Result<JsValue, JsValue> {
    let obj = Object::new();
    match item {
        core_tree_types::HierarchyItem::Node { hash, level, is_leaf, num_entries, path_indices } => {
            Reflect::set(&obj, &"type".into(), &"Node".into())?;
            Reflect::set(&obj, &"hash".into(), &js_sys::Uint8Array::from(&hash[..]).into())?;
            Reflect::set(&obj, &"level".into(), &JsValue::from_f64(level as f64))?;
            Reflect::set(&obj, &"isLeaf".into(), &JsValue::from_bool(is_leaf))?;
            Reflect::set(&obj, &"numEntries".into(), &JsValue::from_f64(num_entries as f64))?;
            let js_path_indices = JsArray::new_with_length(path_indices.len() as u32);
            for (i, val) in path_indices.iter().enumerate() {
                js_path_indices.set(i as u32, JsValue::from_f64(*val as f64));
            }
            Reflect::set(&obj, &"pathIndices".into(), &js_path_indices.into())?;
        }
        core_tree_types::HierarchyItem::InternalEntryItem { parent_hash, entry_index, boundary_key, child_hash, num_items_subtree } => {
            Reflect::set(&obj, &"type".into(), &"InternalEntry".into())?;
            Reflect::set(&obj, &"parentHash".into(), &js_sys::Uint8Array::from(&parent_hash[..]).into())?;
            Reflect::set(&obj, &"entryIndex".into(), &JsValue::from_f64(entry_index as f64))?;
            Reflect::set(&obj, &"boundaryKey".into(), &js_sys::Uint8Array::from(&boundary_key[..]).into())?;
            Reflect::set(&obj, &"childHash".into(), &js_sys::Uint8Array::from(&child_hash[..]).into())?;
            Reflect::set(&obj, &"numItemsSubtree".into(), &JsValue::from_f64(num_items_subtree as f64))?;
        }
        core_tree_types::HierarchyItem::LeafEntryItem { parent_hash, entry_index, key, value_repr_type, value_hash, value_size } => {
            Reflect::set(&obj, &"type".into(), &"LeafEntry".into())?;
            Reflect::set(&obj, &"parentHash".into(), &js_sys::Uint8Array::from(&parent_hash[..]).into())?;
            Reflect::set(&obj, &"entryIndex".into(), &JsValue::from_f64(entry_index as f64))?;
            Reflect::set(&obj, &"key".into(), &js_sys::Uint8Array::from(&key[..]).into())?;
            Reflect::set(&obj, &"valueReprType".into(), &value_repr_type.into())?;
            if let Some(vh) = value_hash {
                Reflect::set(&obj, &"valueHash".into(), &js_sys::Uint8Array::from(&vh[..]).into())?;
            }
            Reflect::set(&obj, &"valueSize".into(), &JsValue::from_f64(value_size as f64))?;
        }
    }
    Ok(obj.into())
}


#[wasm_bindgen]
// Removed Serialize for now, will adjust lib.rs to use JsValue::from()
pub struct WasmHierarchyScanPage {
    items_internal: JsArray, // Keep internal name to avoid conflict with getter
    has_next_page_internal: bool,
    // --- Make this private ---
    next_page_cursor_token_internal: Option<String>,
}

#[wasm_bindgen]
impl WasmHierarchyScanPage {
    // Constructor for internal use, not exposed to JS directly via wasm_bindgen constructor
    // This is how it's populated from From<core_tree_types::HierarchyScanPage>
    fn new(items: JsArray, has_next_page: bool, next_page_cursor_token: Option<String>) -> Self {
        Self {
            items_internal: items,
            has_next_page_internal: has_next_page,
            next_page_cursor_token_internal: next_page_cursor_token,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn items(&self) -> JsArray {
        self.items_internal.clone() // Clone the JsArray reference
    }

    #[wasm_bindgen(getter = hasNextPage)]
    pub fn has_next_page(&self) -> bool {
        self.has_next_page_internal
    }

    // +++ Custom getter for non-Copy type +++
    #[wasm_bindgen(getter = nextPageCursorToken)]
    pub fn next_page_cursor_token(&self) -> Option<String> {
        self.next_page_cursor_token_internal.clone()
    }
}

impl From<core_tree_types::HierarchyScanPage> for WasmHierarchyScanPage {
    fn from(core_page: core_tree_types::HierarchyScanPage) -> Self {
        let js_items = JsArray::new_with_length(core_page.items.len() as u32);
        for (i, core_item) in core_page.items.into_iter().enumerate() {
            match hierarchy_item_to_jsvalue(core_item) {
                Ok(js_item_val) => js_items.set(i as u32, js_item_val),
                Err(_) => {
                    gloo_console::error!("Failed to convert HierarchyItem to JsValue during WasmHierarchyScanPage conversion");
                    // Set to null or undefined if conversion fails for an item
                    js_items.set(i as u32, JsValue::NULL);
                }
            }
        }
        // Use the internal constructor pattern
        WasmHierarchyScanPage::new(
            js_items,
            core_page.has_next_page,
            core_page.next_page_cursor_token,
        )
    }
}

#[wasm_bindgen(js_name = saveTreeToBytesV2)]
pub fn wasm_save_tree_to_bytes_v2(
    tree: &WasmProllyTree, // Assuming WasmProllyTree is your tree wrapper
    description_js: JsValue,
) -> Result<js_sys::Uint8Array, JsValue> {
    // Placeholder - actual implementation will extract data from `tree`
    // let (root_hash, tree_config, chunks_map) = get_tree_components_for_serialization(tree)?;
    // let description: Option<String> = description_js.as_string();
    // file_io_v2::write_prly_tree_v2(root_hash, &tree_config, &chunks_map, description)
    //     .map(|vec_u8| js_sys::Uint8Array::from(&vec_u8[..]))
    //     .map_err(|e| JsValue::from_str(&e.to_string()))
    Err(JsValue::from_str("saveTreeToBytesV2 not fully implemented yet"))
}

// This is likely line 178 or near it
#[wasm_bindgen(js_name = loadTreeFromBytesV2)]
pub fn wasm_load_tree_from_bytes_v2(
    file_bytes_js: js_sys::Uint8Array,
) -> Result<JsValue, JsValue> {
    // Placeholder - actual implementation will call read_prly_tree_v2 and package results
    // let file_bytes = file_bytes_js.to_vec();
    // match file_io_v2::read_prly_tree_v2(&file_bytes) {
    //     Ok((root_hash_opt, tree_config, chunks_map_rust, description_opt)) => {
    //         let result_obj = js_sys::Object::new();
    //         // ... convert components and set on result_obj ...
    //         Ok(result_obj.into())
    //     }
    //     Err(e) => Err(JsValue::from_str(&e.to_string())),
    // }
    Err(JsValue::from_str("loadTreeFromBytesV2 not fully implemented yet"))
}