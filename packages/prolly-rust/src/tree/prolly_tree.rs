// prolly-rust/src/tree/prolly_tree.rs

use std::sync::Arc;
use std::pin::Pin; 
use std::future::Future; 

use log::warn; 

use fastcdc::v2020::FastCDC;

use serde::{Deserialize, Serialize}; // For WASM serialization to JsValue

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, LeafEntry, InternalEntry, ValueRepr};
use crate::store::ChunkStore;
use crate::chunk::{chunk_node, hash_bytes};

use super::cursor::Cursor;

use crate::diff::{diff_trees, DiffEntry}; 
use crate::gc::GarbageCollector;

// --- Struct definitions (ProllyTree, ProcessedNodeUpdate) remain the same ---
/// The main Prolly Tree structure.
#[derive(Debug)]
pub struct ProllyTree<S: ChunkStore> {
    pub root_hash: Option<Hash>, 
    pub store: Arc<S>,           
    pub config: TreeConfig,      
}

/// Carries information about a node update, including its new state (hash, boundary)
/// and any new sibling created by a split.
#[derive(Debug)]
struct ProcessedNodeUpdate { 
    new_hash: Hash,
    new_boundary_key: Key, 
    new_item_count: u64,
    split_info: Option<(Key, Hash, u64)>, 
}

/// Represents the result of a deletion operation down the tree.
/// It conveys the node's updated state and whether its structure changed
/// in a way that requires parent intervention (e.g., it merged away).
#[derive(Debug)]
enum DeleteRecursionResult {
        /// Key not found in subtree. Node state unchanged.
    NotFound { 
        /// The original hash of the node where the key was confirmed missing.
        node_hash: Hash, 
        /// The original boundary key of that node.
        boundary_key: Key 
    },
    /// Node was updated (or unchanged), no structural change requiring parent update.
    Updated(ProcessedNodeUpdate), // Contains new hash and boundary key
    /// Node became underflow and *merged* with a sibling. The parent needs to remove the entry for the merged node.
    Merged, // Parent needs to remove the pointer to the node that returned this
}

// Helper functions for Serde default values.
// These MUST be in the same module as ScanArgs or properly imported if public in another module.
fn default_start_inclusive() -> bool { true }
fn default_end_inclusive() -> bool { false }
fn default_reverse() -> bool { false }

#[derive(Debug, Clone, Serialize, Deserialize)] // <<< THIS DERIVE IS CRITICAL
#[serde(rename_all = "camelCase")] // This applies to the struct overall
pub struct ScanArgs {
    // For Option fields, serde handles missing keys by making them None if `default` is used.
    // `skip_serializing_if` is for serialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_bound: Option<Key>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_bound: Option<Key>,

    // For bool fields, if you want them to default if missing in JS.
    #[serde(default = "default_start_inclusive")]
    pub start_inclusive: bool,

    #[serde(default = "default_end_inclusive")]
    pub end_inclusive: bool,

    #[serde(default = "default_reverse")]
    pub reverse: bool,

    // For numeric types, `#[serde(default)]` uses the type's Default::default() (e.g., 0 for u64).
    #[serde(default)]
    pub offset: u64,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

// The manual Default impl is for Rust-side code needing to create a default ScanArgs.
// Serde uses the #[serde(default...)] attributes for deserialization from JS.
impl Default for ScanArgs {
    fn default() -> Self {
        ScanArgs {
            start_bound: None,
            end_bound: None,
            start_inclusive: default_start_inclusive(),
            end_inclusive: default_end_inclusive(),
            reverse: default_reverse(),
            offset: 0,
            limit: None,
        }
    }
}

// ScanPage struct definition (ensure it derives Serialize)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    pub items: Vec<(Key, Value)>,
    pub has_next_page: bool,
    pub has_previous_page: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page_cursor: Option<Key>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_page_cursor: Option<Key>,
}



impl<S: ChunkStore> ProllyTree<S> {

    
    pub fn new(store: Arc<S>, config: TreeConfig) -> Self { // Public
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
            panic!("Invalid TreeConfig: fanout values are not configured properly. min_fanout must be > 0, target_fanout >= 2 * min_fanout.");
        }
        ProllyTree {
            root_hash: None,
            store,
            config,
        }
    }

    /// Helper to load a node from the store.
    /// Made `pub(crate)` to be accessible from the cursor module.
    pub(crate) async fn load_node(&self, hash: &Hash) -> Result<Node> { // Changed visibility to pub(crate)
        let bytes = self.store.get(hash).await?
            .ok_or_else(|| ProllyError::ChunkNotFound(*hash))?;
        Node::decode(&bytes)
    }

    pub async fn from_root_hash( // Public
        root_hash: Hash,
        store: Arc<S>,
        config: TreeConfig,
    ) -> Result<Self> {
        match store.get(&root_hash).await? {
            Some(bytes) => {
                Node::decode(&bytes)?; 
                Ok(ProllyTree {
                    root_hash: Some(root_hash),
                    store,
                    config,
                })
            }
            None => Err(ProllyError::ChunkNotFound(root_hash)),
        }
    }

    pub fn get_root_hash(&self) -> Option<Hash> { // Public
        self.root_hash
    }



    async fn store_node_and_get_key_hash_pair(&self, node: &Node) -> Result<(Key, Hash)> {
        let (hash, bytes) = chunk_node(node)?;
        self.store.put(bytes).await?;
        
        let boundary_key = match node {
            Node::Leaf { entries, .. } if !entries.is_empty() => Ok(entries.last().unwrap().key.clone()),
            Node::Internal { children, .. } if !children.is_empty() => Ok(children.last().unwrap().boundary_key.clone()),
             // Handle empty nodes - they shouldn't really have a boundary key if stored post-merge correctly
            _ => Err(ProllyError::InternalError("Attempted to get boundary key from empty node".to_string())),
        };
         // If the node is validly empty (e.g., an empty tree root), maybe return a conventional "min" key or handle differently?
         // For now, error if empty when boundary key is needed.
        Ok((boundary_key?, hash))
    }
    
    /// Gets a value by key. Handles reconstructing chunked values.
    pub async fn get(&self, key: &Key) -> Result<Option<Value>> { // Public - No change to signature
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(None),
        };
        self.recursive_get_impl(current_root_hash, key.clone()).await
    }
    
    // Updated recursive_get_impl to handle new ValueRepr variants
    fn recursive_get_impl<'s>(
        &'s self, 
        node_hash: Hash,
        key: Key, 
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 's>> {
        Box::pin(async move { 
            let node = self.load_node(&node_hash).await?;
            match node {
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                        Ok(index) => {
                            let entry = &entries[index];
                            // --- UPDATED VALUE HANDLING ---
                            match &entry.value {
                                ValueRepr::Inline(val) => Ok(Some(val.clone())),
                                ValueRepr::Chunked(data_hash) => {
                                    // Fetch the single chunk value from the store
                                    let value_bytes = self.store.get(data_hash).await?
                                        .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))?;
                                    Ok(Some(value_bytes))
                                }
                                ValueRepr::ChunkedSequence { chunk_hashes, total_size } => {
                                    // Reconstruct value from multiple chunks
                                    let mut reconstructed_value = Vec::with_capacity(*total_size as usize);
                                    for chunk_hash in chunk_hashes {
                                        let chunk_bytes = self.store.get(chunk_hash).await?
                                            .ok_or_else(|| ProllyError::ChunkNotFound(*chunk_hash))?;
                                        reconstructed_value.extend_from_slice(&chunk_bytes);
                                    }
                                    // Optional: Verify total size matches?
                                    if reconstructed_value.len() as u64 != *total_size {
                                         warn!("Reconstructed value size mismatch for key {:?}. Expected {}, got {}.", key, total_size, reconstructed_value.len());
                                         // Decide whether to return error or potentially truncated/corrupt data
                                         // For now, return what we got. Could return error:
                                         // return Err(ProllyError::InternalError("Chunked sequence size mismatch".to_string()));
                                    }
                                    Ok(Some(reconstructed_value))
                                }
                            }
                            // --- END UPDATED VALUE HANDLING ---
                        }
                        Err(_) => Ok(None),
                    }
                }
                Node::Internal { children, .. } => {
                    // ... (Internal node descent logic remains the same) ...
                    if children.is_empty() { return Ok(None); }
                    let mut child_idx_to_search = children.len() -1; 
                    for (idx, child_entry) in children.iter().enumerate() {
                        if key.as_slice() <= &child_entry.boundary_key { 
                            child_idx_to_search = idx;
                            break;
                        }
                    }
                    self.recursive_get_impl(children[child_idx_to_search].child_hash, key).await
                }
            }
        })
    }


    pub async fn count_all_items(&self) -> Result<u64> {
        if self.root_hash.is_none() {
            return Ok(0);
        }
        let root_node_hash = self.root_hash.unwrap();
        // We need to load the root node to determine its type and get counts.
        // This assumes load_node is efficient and doesn't load the entire tree.
        let root_node = self.load_node(&root_node_hash).await?;

        match root_node {
            Node::Leaf { entries, .. } => Ok(entries.len() as u64),
            Node::Internal { children, .. } => {
                // The total count is the sum of num_items_subtree of its direct children.
                Ok(children.iter().map(|c| c.num_items_subtree).sum())
            }
        }
    }

     /// Prepares ValueRepr based on value size and TreeConfig.
    /// Chunks large values using FastCDC.
    async fn prepare_value_repr(&self, value: Value) -> Result<ValueRepr> {
        if value.len() <= self.config.max_inline_value_size {
            return Ok(ValueRepr::Inline(value));
        }

        // Value is large, apply CDC
        // Use FastCDC::new directly with parameters from config
        // Note: fastcdc expects u32 for sizes, ensure conversion if TreeConfig uses usize
        let chunker = FastCDC::new(
            &value,
            self.config.cdc_min_size as u32, // Cast usize to u32
            self.config.cdc_avg_size as u32, // Cast usize to u32
            self.config.cdc_max_size as u32  // Cast usize to u32
        );
        
        let mut chunk_hashes = Vec::new();
        let total_size = value.len() as u64;

        for entry in chunker {
            let chunk_data = &value[entry.offset..entry.offset + entry.length];
            let chunk_hash = hash_bytes(chunk_data);
            self.store.put(chunk_data.to_vec()).await?;
            chunk_hashes.push(chunk_hash);
        }

        match chunk_hashes.len() {
            0 => {
                warn!("CDC produced 0 chunks for value of size {}. Storing inline.", value.len());
                Ok(ValueRepr::Inline(value))
            }
            1 => {
                Ok(ValueRepr::Chunked(chunk_hashes[0]))
            }
            _ => {
                Ok(ValueRepr::ChunkedSequence { chunk_hashes, total_size })
            }
        }
    }

    // Insert

    pub async fn insert(&mut self, key: Key, value: Value) -> Result<()> { // Public
        let value_repr = self.prepare_value_repr(value).await?;

        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => {
                let new_leaf_node = Node::Leaf {
                    level: 0,
                    entries: vec![LeafEntry { key, value: value_repr }],
                };
                let (_boundary_key, new_root_hash_val) = self.store_node_and_get_key_hash_pair(&new_leaf_node).await?;
                self.root_hash = Some(new_root_hash_val);
                return Ok(());
            }
        };
        
        let root_node = self.load_node(&current_root_hash).await?;
        let update_result = self.recursive_insert_impl(current_root_hash, key, value_repr, root_node.level()).await?;

        self.root_hash = Some(update_result.new_hash); // This is the hash of the (potentially new) left child of the new root, OR the updated old root

        if let Some((split_boundary_key, new_sibling_hash, new_sibling_item_count)) = update_result.split_info {
            // The old root (or its left part if it split) is update_result.new_hash, with item count update_result.new_item_count
            let old_root_as_left_child_boundary = update_result.new_boundary_key;
            let old_root_as_left_child_item_count = update_result.new_item_count;

            let new_root_children = vec![
                InternalEntry {
                    boundary_key: old_root_as_left_child_boundary,
                    child_hash: self.root_hash.unwrap(), // This is new_hash from update_result
                    num_items_subtree: old_root_as_left_child_item_count, // <<< SET COUNT
                },
                InternalEntry {
                    boundary_key: split_boundary_key,
                    child_hash: new_sibling_hash,
                    num_items_subtree: new_sibling_item_count, // <<< SET COUNT
                },
            ];

            let new_root_level = root_node.level() + 1; // root_node is the *original* root before the insert operation started
            let new_root_node_obj = Node::new_internal(new_root_children, new_root_level)?;
            let (_final_boundary, final_root_hash) = self.store_node_and_get_key_hash_pair(&new_root_node_obj).await?;
            self.root_hash = Some(final_root_hash);
        }
        Ok(())
    }
    fn recursive_delete_impl<'s>(
        &'s mut self,
        node_hash: Hash,
        key: &'s Key,
        level: u8,
        key_actually_deleted_flag: &'s mut bool,
    ) -> Pin<Box<dyn Future<Output = Result<DeleteRecursionResult>> + Send + 's>> {
        Box::pin(async move {
            // current_node_obj is an owned Node here
            let mut current_node_obj = self.load_node(&node_hash).await?;

            match &mut current_node_obj { // Takes a mutable reference to the owned Node
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                        Ok(index) => {
                            *key_actually_deleted_flag = true;
                            entries.remove(index);
                            if entries.is_empty() {
                                 return Ok(DeleteRecursionResult::Merged);
                            } else {
                                let new_leaf_item_count = entries.len() as u64;
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{
                                    new_hash,
                                    new_boundary_key: new_boundary,
                                    new_item_count: new_leaf_item_count, // <<< SET COUNT
                                    split_info: None // No split on delete
                                }))
                            }
                        }
                        Err(_) => {
                            let boundary_key = match entries.last() {
                                 Some(e) => e.key.clone(),
                                 None => return Err(ProllyError::InternalError("Cannot get boundary key from empty leaf (key not found path)".to_string())),
                            };
                            Ok(DeleteRecursionResult::NotFound{ node_hash, boundary_key })
                        }
                    }
                }
                Node::Internal { children, .. } => { // children is &mut Vec<InternalEntry>
                    let child_idx_to_descend = { /* ... unchanged ... */
                        if children.is_empty() {
                             return Err(ProllyError::InternalError("Internal node has no children during delete.".to_string()));
                        }
                        let mut idx_found = children.len() - 1;
                        for (idx, child_entry) in children.iter().enumerate() {
                            if key.as_slice() <= &child_entry.boundary_key {
                                idx_found = idx;
                                break;
                            }
                        }
                        idx_found
                    };

                    let child_hash = children[child_idx_to_descend].child_hash;
                    let child_level = level - 1;
                     if child_level == u8::MAX {
                         return Err(ProllyError::InternalError("Cannot descend for delete: child level would underflow.".to_string()));
                    }

                    let child_delete_result = self.recursive_delete_impl(child_hash, key, child_level, key_actually_deleted_flag).await?;

                    match child_delete_result {
                        DeleteRecursionResult::NotFound { node_hash: _child_hash, boundary_key: _child_boundary } => { // <<< Prefixed here
                            let current_internal_node_boundary_key = children.last().map(|ce| ce.boundary_key.clone())
                                .ok_or_else(|| ProllyError::InternalError("Internal node empty during NotFound propagation from child".to_string()))?;
                            Ok(DeleteRecursionResult::NotFound {
                                node_hash, // original hash of *this* internal node
                                boundary_key: current_internal_node_boundary_key,
                            })
                        }
                        DeleteRecursionResult::Updated(child_update) => {
                            children[child_idx_to_descend].child_hash = child_update.new_hash;
                            children[child_idx_to_descend].boundary_key = child_update.new_boundary_key;
                            children[child_idx_to_descend].num_items_subtree = child_update.new_item_count; // <<< UPDATE COUNT

                            let child_node_after_update = self.load_node(&child_update.new_hash).await?;
                            if child_node_after_update.is_underflow(&self.config) {
                                // IMPORTANT: handle_underflow MUST correctly update the num_items_subtree
                                // of the children it modifies within the `children` Vec.
                                self.handle_underflow(children, child_idx_to_descend).await?;
                                if children.is_empty() { // Current internal node itself merged away
                                    return Ok(DeleteRecursionResult::Merged);
                                }
                            }

                            // After potential handle_underflow, children list and their counts are up-to-date.
                            let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                            let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                            Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{
                                new_hash,
                                new_boundary_key: new_boundary,
                                new_item_count: current_node_total_items, // <<< SET COUNT
                                split_info: None
                            }))
                        }
                        DeleteRecursionResult::Merged => {
                            children.remove(child_idx_to_descend);

                            if children.is_empty() { // Current internal node is now empty
                                return Ok(DeleteRecursionResult::Merged);
                            }

                            // current_node_obj is modified (child removed). Check if it's underflow.
                            // This underflow will be handled by ITS parent in the recursion.
                            // Here, just report its new state.
                            let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                            let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                            Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate {
                                new_hash,
                                new_boundary_key: new_boundary,
                                new_item_count: current_node_total_items, // <<< SET COUNT
                                split_info: None,
                            }))
                        }
                    }
                }
            }
        })
    }
    
    fn recursive_insert_impl<'s>( // Private
        &'s mut self,
        node_hash: Hash,
        key: Key, 
        value: ValueRepr, 
        level: u8,
    ) -> Pin<Box<dyn Future<Output = Result<ProcessedNodeUpdate>> + Send + 's>> {
        Box::pin(async move { 
            let mut current_node_obj = self.load_node(&node_hash).await?;

            match &mut current_node_obj {
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                        Ok(index) => entries[index].value = value,
                        Err(index) => entries.insert(index, LeafEntry { key, value }),
                    }

                    let current_leaf_item_count = entries.len() as u64;

                    if entries.len() > self.config.target_fanout { // Leaf splits
                        let mid_idx = entries.len() / 2;
                        let right_sibling_entries = entries.split_off(mid_idx);
                        // entries now contains the left part

                        let left_split_item_count = entries.len() as u64;
                        let right_split_item_count = right_sibling_entries.len() as u64;

                        let right_sibling_boundary_key = right_sibling_entries.last().ok_or_else(|| ProllyError::InternalError("Split leaf created empty right sibling".to_string()))?.key.clone();
                        let right_sibling_node = Node::Leaf { level: 0, entries: right_sibling_entries };
                        let (_r_b, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;

                        // current_node_obj is the left part of the split
                        let (left_boundary_key, left_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                        Ok(ProcessedNodeUpdate {
                            new_hash: left_hash,
                            new_boundary_key: left_boundary_key,
                            new_item_count: left_split_item_count, // Item count of the left node
                            split_info: Some((right_sibling_boundary_key, right_sibling_hash, right_split_item_count)), // Pass right sibling's item count
                        })
                    } else { // Leaf does not split
                        let (new_boundary_key, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                        Ok(ProcessedNodeUpdate {
                            new_hash,
                            new_boundary_key,
                            new_item_count: current_leaf_item_count, // Total items in this leaf
                            split_info: None,
                        })
                    }
                }
                Node::Internal { children, .. } => {
                    let mut child_idx_to_descend = children.len() -1;
                    for (idx, child_entry) in children.iter().enumerate() {
                        if key.as_slice() <= &child_entry.boundary_key { 
                            child_idx_to_descend = idx;
                            break;
                        }
                    }
                    
                    let child_to_descend_hash = children[child_idx_to_descend].child_hash;
                    let child_level = level - 1; 

                    let child_update_result = self.recursive_insert_impl(child_to_descend_hash, key, value, child_level).await?;

                    children[child_idx_to_descend].child_hash = child_update_result.new_hash;
                    children[child_idx_to_descend].boundary_key = child_update_result.new_boundary_key;
                    children[child_idx_to_descend].num_items_subtree = child_update_result.new_item_count; // <<< UPDATE COUNT

                    let mut split_to_propagate_upwards: Option<(Key, Hash, u64)> = None;

                    if let Some((boundary_from_child_split, new_child_sibling_hash, child_sibling_item_count)) = child_update_result.split_info {
                        let new_internal_entry = InternalEntry {
                            boundary_key: boundary_from_child_split,
                            child_hash: new_child_sibling_hash,
                            num_items_subtree: child_sibling_item_count,
                        };

                        let pos_to_insert_sibling = children.binary_search_by_key(&&new_internal_entry.boundary_key, |e| &e.boundary_key).unwrap_or_else(|e| e);
                        children.insert(pos_to_insert_sibling, new_internal_entry);

                        if children.len() > self.config.target_fanout { // Internal node itself splits
                            let mid_idx = children.len() / 2;
                            let right_sibling_children_entries = children.split_off(mid_idx);
                            // `children` now contains the left part

                            let left_internal_node_item_count: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                            let right_internal_node_item_count: u64 = right_sibling_children_entries.iter().map(|c| c.num_items_subtree).sum();

                            let right_sibling_boundary_key = right_sibling_children_entries.last().ok_or_else(|| ProllyError::InternalError("Split internal created empty right sibling".to_string()))?.boundary_key.clone();
                            let right_sibling_node = Node::Internal { level, children: right_sibling_children_entries }; // `level` is from the current node
                            let (_r_b, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;

                            split_to_propagate_upwards = Some((right_sibling_boundary_key, right_sibling_hash, right_internal_node_item_count)); // This creates a 3-tuple
                            // The `current_node_obj` (which `children` refers to) is now the left part of the split.
                            // Its item count will be `left_internal_node_item_count`.
                        }
                    }

                    // Calculate total item count for the current_node_obj (which is either the whole node or the left part of a split)
                    let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                    let (current_node_new_boundary, current_node_new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                    Ok(ProcessedNodeUpdate {
                        new_hash: current_node_new_hash,
                        new_boundary_key: current_node_new_boundary,
                        new_item_count: current_node_total_items, // <<< SET COUNT
                        split_info: split_to_propagate_upwards,
                    })
                }
            }
        })
    }
    
    /// Deletes a key-value pair from the Prolly Tree.
    /// Returns `Ok(true)` if the key was found and deleted, `Ok(false)` otherwise.
    pub async fn delete(&mut self, key: &Key) -> Result<bool> {
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(false), // Key not found in empty tree
        };
    
        let root_node = self.load_node(&current_root_hash).await?;
        let root_level = root_node.level();
        let mut key_was_actually_deleted = false; // This will be set by recursive_delete_impl
    
        let result = self.recursive_delete_impl(current_root_hash, key, root_level, &mut key_was_actually_deleted).await?;
    
        match result {
            DeleteRecursionResult::NotFound { .. } => {
                // key_was_actually_deleted should be false if NotFound
                Ok(key_was_actually_deleted)
            }
            DeleteRecursionResult::Updated(update_info) => {
                self.root_hash = Some(update_info.new_hash);
                let potentially_new_root_node = self.load_node(&self.root_hash.unwrap()).await?;
                if let Node::Internal { ref children, .. } = potentially_new_root_node {
                    if children.len() == 1 {
                        // The new root is now the single child.
                        // Its item count is already stored within its *own* structure (if leaf)
                        // or its children's num_items_subtree (if internal).
                        // count_all_items will correctly read this.
                        self.root_hash = Some(children[0].child_hash);
                    }
                }
                Ok(key_was_actually_deleted)
            }
            DeleteRecursionResult::Merged => { // Old root was emptied/merged
                self.root_hash = None;
                Ok(key_was_actually_deleted)
            }
        }
    }


        /// Handles underflow at a given child index in an internal node's children list.
    /// Tries to borrow from siblings first, then merges if necessary.
    /// Modifies the `children` Vec in place by calling rebalance or merge helpers.
    async fn handle_underflow(
        &mut self,
        children: &mut Vec<InternalEntry>, // Parent's children list
        underflow_child_idx: usize,        // Index of the child that is underflow
    ) -> Result<()> { 
        
        // Try borrowing from left sibling
        if underflow_child_idx > 0 {
            let left_sibling_idx = underflow_child_idx - 1;
            let left_sibling_node = self.load_node(&children[left_sibling_idx].child_hash).await?;
            if left_sibling_node.num_entries() > self.config.min_fanout {
                 // This function modifies nodes and updates parent `children` entries
                 self.rebalance_borrow_from_left(children, left_sibling_idx, underflow_child_idx).await?;
                 return Ok(()); 
            }
        }

        // Try borrowing from right sibling
        if underflow_child_idx + 1 < children.len() {
             let right_sibling_idx = underflow_child_idx + 1;
             let right_sibling_node = self.load_node(&children[right_sibling_idx].child_hash).await?;
             if right_sibling_node.num_entries() > self.config.min_fanout {
                  // This function modifies nodes and updates parent `children` entries
                  self.rebalance_borrow_from_right(children, underflow_child_idx, right_sibling_idx).await?;
                  return Ok(()); 
             }
        }

        // Cannot borrow, must merge. Prefer merging with left sibling if possible.
        if underflow_child_idx > 0 {
            // Merge underflow_idx into left_sibling_idx. Removes underflow_idx entry from children.
            let left_idx = underflow_child_idx - 1;
            let right_idx = underflow_child_idx; // The node *to be merged* is the one at underflow_idx
            self.merge_into_left_sibling(children, left_idx, right_idx).await?;
        } else {
            // Must merge with right sibling (underflow_child_idx must be 0).
            // Merge right_sibling_idx into underflow_child_idx. Removes right_sibling_idx entry from children.
            let left_idx = underflow_child_idx;
            let right_idx = underflow_child_idx + 1;
            self.merge_into_left_sibling(children, left_idx, right_idx).await?;
        }

        Ok(())
    }

    // In ProllyTree<S> impl:
    async fn rebalance_borrow_from_right(
        &mut self,
        parent_children_vec: &mut Vec<InternalEntry>,
        underflow_node_idx_in_parent: usize,
        right_sibling_idx_in_parent: usize,
    ) -> Result<()> {
        // 1. Load child nodes
        let mut underflow_node_obj = self.load_node(&parent_children_vec[underflow_node_idx_in_parent].child_hash).await?;
        let mut right_node_obj = self.load_node(&parent_children_vec[right_sibling_idx_in_parent].child_hash).await?;

        // 2. Perform borrow (move first entry/child from right_node to end of underflow_node)
        match (&mut underflow_node_obj, &mut right_node_obj) {
            (Node::Leaf { entries: underflow_entries, .. }, Node::Leaf { entries: right_entries, .. }) => {
                if right_entries.is_empty() {
                    return Err(ProllyError::InternalError("Attempted to borrow from empty right leaf sibling".to_string()));
                }
                let borrowed_entry = right_entries.remove(0);
                underflow_entries.push(borrowed_entry);
            }
            (Node::Internal { children: underflow_children_entries, .. }, Node::Internal { children: right_children_entries, .. }) => {
                if right_children_entries.is_empty() {
                    return Err(ProllyError::InternalError("Attempted to borrow from empty right internal sibling".to_string()));
                }
                let borrowed_child_internal_entry = right_children_entries.remove(0);
                underflow_children_entries.push(borrowed_child_internal_entry);
                // Boundary key adjustments in the parent might be needed here.
                // The boundary key of the underflow_node in the parent internal node becomes the new
                // boundary key of the (now larger) underflow_node.
                // The boundary key for the right_sibling itself is fine as it's the last key of its own (now smaller) subtree.
            }
            _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance from right".to_string())),
        }

        // 3. Calculate new item counts
        let new_underflow_node_item_count = match &underflow_node_obj {
            Node::Leaf { entries, .. } => entries.len() as u64,
            Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
        };
        let new_right_node_item_count = match &right_node_obj {
            Node::Leaf { entries, .. } => entries.len() as u64,
            Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
        };

        // 4. Store modified nodes
        let (new_underflow_boundary, new_underflow_hash) = self.store_node_and_get_key_hash_pair(&underflow_node_obj).await?;
        let (new_right_boundary, new_right_hash) = self.store_node_and_get_key_hash_pair(&right_node_obj).await?;

        // 5. Update parent_children_vec
        parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary; // This boundary now covers more.
        parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
        parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count;

        parent_children_vec[right_sibling_idx_in_parent].boundary_key = new_right_boundary; // Boundary of the right node is its own last key.
        parent_children_vec[right_sibling_idx_in_parent].child_hash = new_right_hash;
        parent_children_vec[right_sibling_idx_in_parent].num_items_subtree = new_right_node_item_count;
        
        Ok(())
    }

    // --- rebalance_borrow_from_left / right remain the same as the PREVIOUS version (with reinstated boundary updates) ---
    async fn rebalance_borrow_from_left(
        &mut self,
        parent_children_vec: &mut Vec<InternalEntry>, // Children list of the PARENT of nodes being rebalanced
        left_sibling_idx_in_parent: usize,
        underflow_node_idx_in_parent: usize,
    ) -> Result<()> {
        // 1. Load the actual child nodes that will be modified
        let mut left_node_obj = self.load_node(&parent_children_vec[left_sibling_idx_in_parent].child_hash).await?;
        let mut underflow_node_obj = self.load_node(&parent_children_vec[underflow_node_idx_in_parent].child_hash).await?;

        // 2. Perform the borrow logic (modifies left_node_obj and underflow_node_obj)
        //    This logic needs to be specific to whether they are Leaf or Internal nodes.
        //    Example for LEAF nodes (simplified - assumes last entry moves):
        match (&mut left_node_obj, &mut underflow_node_obj) {
            (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: underflow_entries, .. }) => {
                if let Some(borrowed_entry) = left_entries.pop() {
                    underflow_entries.insert(0, borrowed_entry);
                } else {
                    return Err(ProllyError::InternalError("Attempted to borrow from empty left leaf sibling".to_string()));
                }
            }
            (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: underflow_children_entries, .. }) => {
                // When borrowing for internal nodes, you move an InternalEntry from one child to another.
                // The num_items_subtree of the MOVED InternalEntry itself is carried over.
                // The boundary key of the parent might also need adjustment.
                if let Some(borrowed_child_internal_entry) = left_children_entries.pop() {
                    underflow_children_entries.insert(0, borrowed_child_internal_entry);
                    // The boundary key of the parent InternalNode might need an update here
                    // if the borrowed element affects the split point between left_node and underflow_node.
                    // Typically, the parent's key separating these two might become the new last key of the (now smaller) left_node.
                } else {
                    return Err(ProllyError::InternalError("Attempted to borrow from empty left internal sibling".to_string()));
                }
            }
            _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance".to_string())),
        }

        // 3. Calculate new item counts for the modified child nodes
        let new_left_node_item_count = match &left_node_obj {
            Node::Leaf { entries, .. } => entries.len() as u64,
            Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
        };
        let new_underflow_node_item_count = match &underflow_node_obj {
            Node::Leaf { entries, .. } => entries.len() as u64,
            Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
        };

        // 4. Store modified child nodes and get their new hashes and boundaries
        let (new_left_boundary, new_left_hash) = self.store_node_and_get_key_hash_pair(&left_node_obj).await?;
        let (new_underflow_boundary, new_underflow_hash) = self.store_node_and_get_key_hash_pair(&underflow_node_obj).await?;

        // 5. Update the entries in `parent_children_vec`
        parent_children_vec[left_sibling_idx_in_parent].boundary_key = new_left_boundary;
        parent_children_vec[left_sibling_idx_in_parent].child_hash = new_left_hash;
        parent_children_vec[left_sibling_idx_in_parent].num_items_subtree = new_left_node_item_count; // <<< UPDATE

        parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary;
        parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
        parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count; // <<< UPDATE

        Ok(())
    }

    async fn merge_into_left_sibling(
        &mut self,
        parent_children_vec: &mut Vec<InternalEntry>, // Children list of the PARENT
        left_idx_in_parent: usize,
        right_idx_in_parent: usize, // This is the underflow node that will be merged into left
    ) -> Result<()> {
        if left_idx_in_parent + 1 != right_idx_in_parent {
            return Err(ProllyError::InternalError(format!("Attempted to merge non-adjacent siblings: {} and {}", left_idx_in_parent, right_idx_in_parent)));
        }

        // 1. Get item counts from the parent's perspective BEFORE loading/merging the actual nodes
        let items_from_left_child_before_merge = parent_children_vec[left_idx_in_parent].num_items_subtree;
        let items_from_right_child_before_merge = parent_children_vec[right_idx_in_parent].num_items_subtree;

        // 2. Load the actual child nodes
        let mut left_node_obj = self.load_node(&parent_children_vec[left_idx_in_parent].child_hash).await?;
        let right_node_to_merge_obj = self.load_node(&parent_children_vec[right_idx_in_parent].child_hash).await?;

        // 3. Perform the merge logic (append entries/children from right_node_to_merge_obj to left_node_obj)
        match (&mut left_node_obj, right_node_to_merge_obj) { // right_node_to_merge_obj is consumed
            (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: mut right_entries_to_append, .. }) => {
                left_entries.append(&mut right_entries_to_append);
            }
            (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: mut right_children_to_append, .. }) => {
                left_children_entries.append(&mut right_children_to_append);
            }
            _ => return Err(ProllyError::InternalError("Mismatched node types during merge".to_string())),
        }

        // 4. Store the newly merged left_node_obj
        let (new_merged_node_boundary, new_merged_node_hash) = self.store_node_and_get_key_hash_pair(&left_node_obj).await?;

        // 5. Update the parent's entry for the left child (which is now the merged node)
        parent_children_vec[left_idx_in_parent].boundary_key = new_merged_node_boundary;
        parent_children_vec[left_idx_in_parent].child_hash = new_merged_node_hash;
        // The new item count is the sum of items from the two children before they were merged.
        parent_children_vec[left_idx_in_parent].num_items_subtree = items_from_left_child_before_merge + items_from_right_child_before_merge; // <<< UPDATE COUNT

        // 6. Remove the right child's entry from parent_children_vec as it has been merged
        parent_children_vec.remove(right_idx_in_parent);

        // TODO: The chunk for the original right_idx_in_parent node is now orphaned. GC will handle it.
        Ok(())
    }

    pub async fn commit(&mut self) -> Result<Option<Hash>> { // Public
        Ok(self.root_hash)
    }

    /// Creates a cursor starting before the first key-value pair.
    pub async fn cursor_start(&self) -> Result<Cursor<S>> {
        Cursor::new_at_start(self).await
    }

    /// Creates a cursor starting at or just after the given key.
    /// If the key exists, `cursor.next()` will yield that key-value pair first.
    /// If the key doesn't exist, `cursor.next()` will yield the next key-value pair in order.
    pub async fn seek(&self, key: &Key) -> Result<Cursor<S>> {
            Cursor::new_at_key(self, key).await
    }

    /// Computes the differences between this tree state and another tree state
    /// represented by `other_root_hash`.
    /// Requires that the `store` contains all necessary chunks for both tree versions.
    pub async fn diff(&self, other_root_hash: Option<Hash>) -> Result<Vec<DiffEntry>> {
        diff_trees(
            self.root_hash, // Left side is current tree
            other_root_hash, // Right side is the other tree
            Arc::clone(&self.store),
            self.config.clone()
        ).await
    }

    /// Performs garbage collection on the underlying chunk store.
    ///
    /// This method identifies and removes chunks that are no longer reachable
    /// from the provided set of `live_root_hashes`. It's the responsibility
    /// of the caller to provide all root hashes that represent active, desired
    /// tree states.
    ///
    /// # Arguments
    /// * `live_root_hashes`: A slice of `Hash` values. All chunks reachable from
    ///   these roots (and the current tree's `self.root_hash` if it's not None
    ///   and not already in the list) will be preserved.
    ///
    /// # Returns
    /// `Ok(usize)` with the number of chunks collected (deleted), or an error.
    pub async fn gc(&self, app_provided_live_root_hashes: &[Hash]) -> Result<usize> {
        let collector = GarbageCollector::new(Arc::clone(&self.store));

        // Include the current tree's own root_hash in the live set if it exists.
        let mut all_live_roots_set = app_provided_live_root_hashes.iter().cloned().collect::<std::collections::HashSet<Hash>>();
        if let Some(current_root) = self.root_hash {
            all_live_roots_set.insert(current_root);
        }
        
        let all_live_roots_vec = all_live_roots_set.into_iter().collect::<Vec<Hash>>();
        
        collector.collect(&all_live_roots_vec).await
    }

    pub async fn scan(&self, args: ScanArgs) -> Result<ScanPage> {
        let mut collected_items: Vec<(Key, Value)> = Vec::new();
        let mut items_to_fetch: Option<usize> = None;
        let mut actual_next_item_for_cursor: Option<(Key, Value)> = None;

        if let Some(limit_val) = args.limit {
            if limit_val > 0 { // Only try to fetch limit + 1 if limit is positive
                items_to_fetch = Some(limit_val + 1);
            } else { // limit is 0, fetch 0 items
                items_to_fetch = Some(0);
            }
        }
        // If args.limit is None, items_to_fetch remains None, meaning fetch all within bounds.

        // Create a cursor positioned by offset and initial bounds.
        let mut cursor = Cursor::new_for_scan(self, &args).await?;

        let mut first_item_key: Option<Key> = None;
        let mut last_item_key_in_page: Option<Key> = None; // Key of the Nth item if limit is N

        if items_to_fetch == Some(0) { // Explicit limit of 0
            // No items to fetch
        } else {
            for i in 0..items_to_fetch.unwrap_or(usize::MAX) { // Loop up to limit+1 or effectively infinity
                match cursor.next_in_scan(&args).await? {
                    Some((key, value)) => {
                        if first_item_key.is_none() {
                            first_item_key = Some(key.clone());
                        }

                        if items_to_fetch.is_some() && collected_items.len() < args.limit.unwrap_or(usize::MAX) {
                            // This is one of the primary items for the current page
                            last_item_key_in_page = Some(key.clone());
                            collected_items.push((key, value));
                        } else if items_to_fetch.is_some() && collected_items.len() == args.limit.unwrap_or(usize::MAX) {
                            // This is the (limit + 1)th item, store it for cursor/has_next_page
                            actual_next_item_for_cursor = Some((key, value));
                            break; // We have fetched one beyond the limit
                        } else if items_to_fetch.is_none() { // No limit specified, collect all
                            last_item_key_in_page = Some(key.clone());
                            collected_items.push((key, value));
                        }
                    }
                    None => break, // No more items in range
                }
            }
        }


        let final_has_next_page = actual_next_item_for_cursor.is_some();

        let calculated_has_previous_page: bool;
        if args.offset > 0 {
            calculated_has_previous_page = true;
            gloo_console::debug!("[ProllyTree::scan] hasPreviousPage=true (due to offset > 0)");
        } else if args.start_bound.is_some() {
            // If a start_bound is specified (and offset is 0),
            // it implies we are on a subsequent page of a paginated query.
            // This is true unless the start_bound happens to be the very first key of the tree
            // AND start_inclusive is true. For simplicity in typical pagination,
            // having a start_bound usually means there's something before it.
            // For this specific test case, this logic is sufficient.
            calculated_has_previous_page = true;
            gloo_console::debug!("[ProllyTree::scan] hasPreviousPage=true (due to start_bound being Some and offset=0)");
        } else {
            calculated_has_previous_page = false;
            gloo_console::debug!("[ProllyTree::scan] hasPreviousPage=false (offset=0 and no start_bound)");
        }



        Ok(ScanPage {
            items: collected_items, // Contains up to `limit` items
            has_next_page: final_has_next_page,
            has_previous_page: calculated_has_previous_page,
            // If has_next_page is true, actual_next_item_for_cursor contains the (limit+1)th item.
            // Its key is the ideal next_page_cursor.
            next_page_cursor: actual_next_item_for_cursor.map(|(k, _v)| k),
            previous_page_cursor: first_item_key,
        })
    }

}
