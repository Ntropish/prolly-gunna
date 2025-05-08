//! Super‑simple single‑leaf prolly‑tree; splits come later.
use crate::{node::{Node, LeafEntry}, store::ChunkStore, store::memory::InMemoryStore};
use crate::chunk::{chunk_node, hash_bytes};
use std::rc::Rc;
use std::cell::RefCell;
use std::any::Any; // This import is needed for downcast_ref on &dyn Any

pub type Hash = [u8; 32];

pub struct Tree<S: ChunkStore + 'static> { // S must be 'static for Any due to ChunkStore: Any
    root: Node,
    dirty: bool,
    store: Rc<RefCell<S>>,
}

impl<S: ChunkStore + 'static> Tree<S> {
    /// Empty tree.
    pub fn new(store: Rc<RefCell<S>>) -> Self { Self { root: Node::empty_leaf(), dirty: true, store } }

    /// Decode `root_hash` using `store`.
    pub fn from_root(root_hash: Hash, store: Rc<RefCell<S>>) -> Result<Self, String> {
        let bytes = self.store.borrow().get(&root_hash).ok_or("root chunk missing")?;
        let node = Node::decode(&bytes);
        Ok(Self { root: node, dirty: false, store })
    }

    // ------------ CRUD ------------
    pub fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        match &self.root {
            Node::Leaf { entries } => entries.binary_search_by(|e| e.key.as_slice().cmp(key))
                .ok()
                .map(|idx| entries[idx].value.clone()),
            _ => unreachable!(),
        }
    }

    pub fn insert(&mut self, key: Vec<u8>, value: Vec<u8>) {
        if let Node::Leaf { entries } = &mut self.root {
            match entries.binary_search_by(|e| e.key.as_slice().cmp(&key)) {
                Ok(idx) => entries[idx].value = value,
                Err(pos) => entries.insert(pos, LeafEntry { key, value }),
            }
            self.dirty = true;
        }
    }

    pub fn delete(&mut self, key: &[u8]) -> bool {
        if let Node::Leaf { entries } = &mut self.root {
            if let Ok(idx) = entries.binary_search_by(|e| e.key.as_slice().cmp(key)) {
                entries.remove(idx);
                self.dirty = true;
                return true;
            }
        }
        false
    }

    /// Re‑chunk root if dirty; returns new hash.
    pub fn commit(&mut self) -> Hash {
        if self.dirty {
            let (h, bytes) = chunk_node(&self.root);
            self.store.borrow_mut().put(&bytes);
            self.dirty = false;
            h
        } else {
            hash_bytes(&self.root.encode())
        }
    }

    /// Helper for wasm tests – export all in‑RAM chunks as JS `Map`.
    /// This method is specific to when S is InMemoryStore.
    #[cfg(target_arch="wasm32")]
    pub fn export_chunks_js(&self) -> js_sys::Map {
        use js_sys::{Uint8Array, Map}; // Uint8Array is used here
        // InMemoryStore is already imported at the top of the file

        let map = Map::new();
        let store_borrow = self.store.borrow();
        // S implements ChunkStore, which implements Any. So store_borrow.as_any() is valid.
        // The as_any() method is called on the concrete type S, not on the RefCell guard.
        if let Some(mem_store) = (*store_borrow).as_any().downcast_ref::<InMemoryStore>() {
            for (h, v) in &mem_store.0 { // Access the HashMap directly from InMemoryStore
                map.set(&Uint8Array::from(&h[..]), &Uint8Array::from(&v[..]));
            }
        }
        map
    }
}