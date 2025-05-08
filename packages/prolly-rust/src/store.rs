//! Pluggable chunk storage.  Starts with an in‑RAM HashMap.
use std::collections::HashMap;
use wasm_bindgen::{JsCast, JsValue};
use js_sys::{Map, Uint8Array, Array as JsArray};
use crate::chunk::hash_bytes;
use std::any::Any;

pub type Hash = [u8; 32];

// S must implement Any for downcasting purposes if needed
pub trait ChunkStore: Any {
    fn get(&self, h: &Hash) -> Option<Vec<u8>>;
    fn put(&mut self, bytes: &[u8]) -> Hash;
    fn as_any(&self) -> &dyn Any;       // To get an immutable Any reference
}

// REMOVED the problematic: impl<T: ChunkStore + 'static> ChunkStore for Rc<RefCell<T>> { ... }

pub mod memory {
    use super::*;

    #[derive(Default)]
    pub struct InMemoryStore(pub HashMap<Hash, Vec<u8>>);

    impl ChunkStore for InMemoryStore {
        fn get(&self, h: &Hash) -> Option<Vec<u8>> { self.0.get(h).cloned() }
        fn put(&mut self, bytes: &[u8]) -> Hash {
            let h = hash_bytes(bytes);
            self.0.insert(h, bytes.to_vec());
            h
        }
        fn as_any(&self) -> &dyn Any { self }
    }

    impl InMemoryStore {
        /// Convert a JS `Map<Uint8Array, Uint8Array>` ➜ Rust HashMap.
        pub fn from_js_map(map: &Map) -> Result<Self, JsValue> {
            let mut inner = HashMap::new();
            let entries = js_sys::try_iter(map)?.ok_or_else(|| JsValue::from_str("not iterable"))?;
            for entry_result in entries {
                let entry = entry_result?;
                let pair_array = entry.dyn_into::<JsArray>()?;

                let key_js = pair_array.get(0);
                let val_js = pair_array.get(1);

                let key_u8array = key_js.dyn_into::<Uint8Array>()?;
                let val_u8array = val_js.dyn_into::<Uint8Array>()?;

                if key_u8array.length() != 32 {
                    return Err(JsValue::from_str("Hash key must be 32 bytes long"));
                }
                let mut h: Hash = [0u8; 32];
                key_u8array.copy_to(&mut h);
                inner.insert(h, val_u8array.to_vec());
            }
            Ok(Self(inner))
        }
    }
}