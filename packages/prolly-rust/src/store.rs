//! Pluggable chunk storage.  Starts with an in‑RAM HashMap.
use std::collections::HashMap;
use wasm_bindgen::{JsCast, JsValue};
use js_sys::{Map, Uint8Array};

pub type Hash = [u8; 32];

pub trait ChunkStore {
    fn get(&self, h: &Hash) -> Option<Vec<u8>>;
    fn put(&self, bytes: &[u8]) -> Hash;
}

// Allow every `Rc<T>` where `T: ChunkStore` to behave like a store.
impl<T: ChunkStore> ChunkStore for std::rc::Rc<T> {
    fn get(&self, h: &Hash) -> Option<Vec<u8>> { (**self).get(h) }
    fn put(&self, bytes: &[u8]) -> Hash { (**self).put(bytes) }
}

pub mod memory {
    use super::*;

    #[derive(Default)]
    pub struct InMemoryStore(pub HashMap<Hash, Vec<u8>>);

    impl ChunkStore for InMemoryStore {
        fn get(&self, h: &Hash) -> Option<Vec<u8>> { self.0.get(h).cloned() }
        fn put(&self, bytes: &[u8]) -> Hash {
            let h = crate::hash_bytes(bytes);
            self.0.insert(h, bytes.to_vec());
            h
        }
        fn as_any_mut(&mut self) -> Option<&mut dyn Any> { Some(self) }
    }

    impl InMemoryStore {
        /// Convert a JS `Map<Uint8Array, Uint8Array>` ➜ Rust HashMap.
        pub fn from_js_map(map: &Map) -> Result<Self, JsValue> {
            let mut inner = HashMap::new();
            let entries = js_sys::try_iter(map)?.ok_or("not iterable")?;
            for entry in entries {
                let pair = entry?.dyn_into::<js_sys::Array>()?::<js_sys::Array>()?;
                let key = pair.get(0).dyn_into::<Uint8Array>()?;
                let val = pair.get(1).dyn_into::<Uint8Array>()?;
                let mut h: Hash = [0u8; 32];
                key.copy_to(&mut h);
                inner.insert(h, val.to_vec());
            }
            Ok(Self(inner))
        }
    }
}