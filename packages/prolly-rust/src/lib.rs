// prolly-rust/src/lib.rs

// ... (wasm-bindgen prelude) ...

pub mod common;
pub mod error;
pub mod store; 
pub mod node;
pub mod chunk; // Assuming chunk.rs is at src/chunk.rs
// pub mod cdc;
// pub mod tree;

// Old files to be refactored/removed:
// mod tree;   // This will eventually be crate::tree::prolly_tree
// mod chunk;  // Parts into crate::chunk, hash_bytes used by mem_store
// mod node;   // This will eventually be crate::node::definition
// mod store;  // This is now replaced by crate::store
// mod diff;

// We need to ensure `crate::chunk::hash_bytes` is accessible for mem_store.
// For now, let's assume your old `chunk.rs` still provides it.
// If you've moved Hash to common.rs, update chunk.rs:
// Original chunk.rs:
// pub mod chunk { // if it's not already a module
//    use crate::common::Hash; // <<<< Change here
//    use blake3::Hasher;
//    // use crate::node::Node; // If Node is used here, might need to be crate::node::definition::Node

//    pub fn hash_bytes(bytes: &[u8]) -> Hash {
//        Hasher::new().update(bytes).finalize().into()
//    }

//    // pub fn chunk_node(node: &Node) -> (Hash, Vec<u8>) { // Node type will change
//    //     let encoded = node.encode();
//    //     (hash_bytes(&encoded), encoded)
//    // }
// }
// If chunk.rs is just a file, not a module:
// src/chunk.rs
// use crate::common::Hash; // <<<< Change here
// use blake3::Hasher;
// ...

// To make `hash_bytes` available as `crate::chunk::hash_bytes`:
// 1. Ensure `chunk.rs` exists at `src/chunk.rs`.
// 2. Add `pub mod chunk;` to `lib.rs`.


// ... (rest of your existing lib.rs which will use these new store components) ...

// Example of how ProllyTree might start to change:
/*
use crate::common::{Hash, TreeConfig};
use crate::store::ChunkStore; // Use the new trait
use crate::error::Result;
use std::sync::Arc; // For Arc<dyn ChunkStore> or Arc<S>

// This is just a forward-looking sketch
pub struct ProllyTree<S: ChunkStore> {
    root_hash: Option<Hash>, // A tree might be empty initially
    store: Arc<S>,
    config: TreeConfig,
    // dirty_nodes: HashMap<Hash, Node> // or some other way to track changes
}

impl<S: ChunkStore> ProllyTree<S> {
    pub fn new(store: Arc<S>, config: TreeConfig) -> Self {
        Self {
            root_hash: None, // Or initialize with an empty leaf node stored & get its hash
            store,
            config,
        }
    }

    // ... async methods ...
}
*/

// Your existing ProllyTree and wasm_bindgen parts will need significant
// refactoring to use the async ChunkStore and the new error types.
// We'll tackle that after defining the node structures.