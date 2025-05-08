//! Super‑simple single‑leaf prolly‑tree; splits come later.
use crate::{node::{Node, LeafEntry}, store::ChunkStore};
use crate::chunk::{chunk_node, hash_bytes};
use std::rc::Rc;

pub type Hash = [u8; 32];

pub struct Tree<S: ChunkStore> {
    root: Node,   // always a leaf for now
    dirty: bool,  // need to (re)chunk on commit
    store: Rc<S>,
}

impl<S: ChunkStore> Tree<S> {
    /// Empty tree.
    pub fn new(store: Rc<S>) -> Self { Self { root: Node::empty_leaf(), dirty: true, store } }

    /// Decode `root_hash` using `store`.
    pub fn from_root(root_hash: Hash, store: Rc<S>) -> Result<Self, String> {
        let bytes = store.get(&root_hash).ok_or("root chunk missing")?;
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
                Ok(idx) => entries[idx].value = value,           // overwrite
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
            self.store.put(&bytes); // ensures chunk present
            self.dirty = false;
            h
        } else {
            // root was already stored; recompute hash for API symmetry
            hash_bytes(&self.root.encode())
        }
    }

    /// Helper for wasm tests – export all in‑RAM chunks as JS `Map`.
    #[cfg(target_arch="wasm32")]
    pub fn export_chunks_js(&self) -> js_sys::Map {
        use js_sys::{Uint8Array, Map};
        let map = Map::new();
        if let Some(mem) = Rc::get_mut(&mut Rc::clone(&self.store)).and_then(|s| s.as_any_mut()) {
            for (h, v) in &mem.0 {
                map.set(&Uint8Array::from(&h[..]), &Uint8Array::from(&v[..]));
            }
        }
        map
    }
}