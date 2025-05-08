//! Wasm entry surface – tiny and opinionated.
#![cfg(target_arch = "wasm32")]

mod tree;
mod chunk;
mod node;
mod store;
mod diff;

use wasm_bindgen::prelude::*;
use store::memory::InMemoryStore;
// Removed: use store::ChunkStore; // This import is no longer needed here
use std::rc::Rc;
use std::cell::RefCell;

/// Public wrapper exported to JavaScript.
#[wasm_bindgen]
pub struct ProllyTree {
    inner: tree::Tree<InMemoryStore>,
}

#[wasm_bindgen]
impl ProllyTree {
    /// Construct an empty in‑memory tree.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let store = Rc::new(RefCell::new(InMemoryStore::default()));
        Self { inner: tree::Tree::new(store) }
    }

    /// Re‑hydrate from `root` + `chunks` (a JS `Map<hash, Uint8Array>`).
    #[wasm_bindgen(js_name = "load")]
    pub fn load(root: &[u8], chunks: &js_sys::Map) -> Result<ProllyTree, JsValue> {
        let mem_store = InMemoryStore::from_js_map(chunks)?;
        let store = Rc::new(RefCell::new(mem_store));
        let root_hash_array: [u8; 32] = root.try_into().map_err(|_| JsValue::from_str("Root hash must be 32 bytes"))?;
        let inner = tree::Tree::from_root(root_hash_array, store)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(Self { inner })
    }

    // -------- key/value API --------
    pub fn get(&self, key: &[u8]) -> Option<js_sys::Uint8Array> {
        self.inner.get(key).map(|v| js_sys::Uint8Array::from(&v[..]))
    }

    pub fn insert(&mut self, key: &[u8], value: &[u8]) {
        self.inner.insert(key.to_vec(), value.to_vec());
    }

    pub fn delete(&mut self, key: &[u8]) -> bool { self.inner.delete(key) }

    /// Flush dirty chunks, returning new root hash.
    pub fn commit(&mut self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&self.inner.commit()[..])
    }
}

// ---------- unit tests (run with wasm‑bindgen‑test) ----------

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn roundtrip() {
        let mut t = ProllyTree::new();
        t.insert(b"alice", b"hello");
        t.insert(b"bob", b"world");
        let root_js_array = t.commit();
        let mut root_hash = [0u8; 32];
        root_js_array.copy_to(&mut root_hash);


        assert_eq!(t.get(b"alice").unwrap().to_vec(), b"hello");

        // Simulate peer loading from exported chunks
        let chunks_map = t.inner.export_chunks_js();
        let t2 = ProllyTree::load(&root_hash, &chunks_map).unwrap();
        assert_eq!(t2.get(b"bob").unwrap().to_vec(), b"world");
    }
}