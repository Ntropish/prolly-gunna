// prolly-rust/src/tree/prolly_tree.rs

use std::sync::Arc;
use std::pin::Pin; 
use std::future::Future; 

use log::warn; 

use fastcdc::v2020::FastCDC;


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
    split_info: Option<(Key, Hash)>, 
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


impl<S: ChunkStore> ProllyTree<S> {
    // --- new, from_root_hash, get_root_hash, load_node, store_node_and_get_key_hash_pair ---
    // --- get, recursive_get, insert, prepare_value_repr, recursive_insert ---
    // (Keep the existing implementations for these methods from the previous step)
    
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

        self.root_hash = Some(update_result.new_hash); 

        if let Some((split_boundary_key, new_sibling_hash)) = update_result.split_info {
            let old_root_as_left_child_boundary = update_result.new_boundary_key; 
            
            let new_root_children = vec![
                InternalEntry {
                    boundary_key: old_root_as_left_child_boundary,
                    child_hash: self.root_hash.unwrap(), 
                },
                InternalEntry {
                    boundary_key: split_boundary_key, 
                    child_hash: new_sibling_hash,
                },
            ];
            
            let new_root_level = root_node.level() + 1;
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
                                // Pass an immutable reference to the (modified) owned current_node_obj
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{ new_hash, new_boundary_key: new_boundary, split_info: None }))
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
                        DeleteRecursionResult::NotFound { .. } => { /* ... unchanged ... */
                             let boundary_key = children.last().map(|ce| ce.boundary_key.clone())
                                 .ok_or_else(|| ProllyError::InternalError("Cannot get boundary key from empty internal node (not found path)".to_string()))?;
                             Ok(DeleteRecursionResult::NotFound { node_hash, boundary_key })
                        }
                        DeleteRecursionResult::Updated(child_update) => {
                             children[child_idx_to_descend].child_hash = child_update.new_hash;
                             children[child_idx_to_descend].boundary_key = child_update.new_boundary_key;

                             let child_node = self.load_node(&child_update.new_hash).await?;
                             let needs_rebalance_or_merge = child_node.is_underflow(&self.config);

                             if needs_rebalance_or_merge {
                                 self.handle_underflow(children, child_idx_to_descend).await?;
                                 if children.is_empty() { return Ok(DeleteRecursionResult::Merged); }
                             }

                            if children.is_empty() {
                                Ok(DeleteRecursionResult::Merged)
                            } else {
                                // Pass an immutable reference to the (modified) owned current_node_obj
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?; // <--- FIX APPLIED (was &*current_node_obj)
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{ new_hash, new_boundary_key: new_boundary, split_info: None }))
                            }
                        }
                        DeleteRecursionResult::Merged => {
                            children.remove(child_idx_to_descend);

                            if children.is_empty() {
                                return Ok(DeleteRecursionResult::Merged);
                            }

                            // Get an immutable reference to the (modified) owned current_node_obj
                            let node_ref_for_check: &Node = &current_node_obj; // <--- FIX APPLIED (was &*current_node_obj)
                            let is_node_underflow = node_ref_for_check.is_underflow(&self.config);
                            
                            let num_children_after_remove = match node_ref_for_check {
                                Node::Internal { children: c, .. } => c.len(),
                                _ => 0, 
                            };

                            if level > 0 && is_node_underflow && num_children_after_remove < self.config.min_fanout {
                                Ok(DeleteRecursionResult::Merged)
                            } else {
                                // Pass the immutable reference node_ref_for_check (or just &current_node_obj directly)
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(node_ref_for_check).await?;
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate {
                                    new_hash,
                                    new_boundary_key: new_boundary,
                                    split_info: None,
                                }))
                            }
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

                    if entries.len() > self.config.target_fanout {
                        let mid_idx = entries.len() / 2;
                        let right_sibling_entries = entries.split_off(mid_idx); 

                        let right_sibling_boundary_key = right_sibling_entries.last().ok_or_else(|| ProllyError::InternalError("Split leaf created empty right sibling".to_string()))?.key.clone();
                        let right_sibling_node = Node::Leaf { level: 0, entries: right_sibling_entries };
                        let (_r_boundary, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;
                        
                        let (left_boundary_key, left_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                        Ok(ProcessedNodeUpdate {
                            new_hash: left_hash,
                            new_boundary_key: left_boundary_key,
                            split_info: Some((right_sibling_boundary_key, right_sibling_hash)),
                        })
                    } else {
                        let (new_boundary_key, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                        Ok(ProcessedNodeUpdate { new_hash, new_boundary_key, split_info: None })
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

                    let mut split_to_propagate = None;

                    if let Some((boundary_from_child_split, new_child_sibling_hash)) = child_update_result.split_info {
                        let new_internal_entry = InternalEntry {
                            boundary_key: boundary_from_child_split,
                            child_hash: new_child_sibling_hash,
                        };
                        
                        let pos_to_insert_sibling = children.binary_search_by_key(&&new_internal_entry.boundary_key, |e| &e.boundary_key).unwrap_or_else(|e| e);
                        children.insert(pos_to_insert_sibling, new_internal_entry);

                        if children.len() > self.config.target_fanout {
                            let mid_idx = children.len() / 2;
                            let right_sibling_children = children.split_off(mid_idx);

                            let right_sibling_boundary_key = right_sibling_children.last().ok_or_else(|| ProllyError::InternalError("Split internal created empty right sibling".to_string()))?.boundary_key.clone();
                            let right_sibling_node = Node::Internal { level, children: right_sibling_children }; 
                            let (_r_boundary, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;
                            
                            split_to_propagate = Some((right_sibling_boundary_key, right_sibling_hash));
                        }
                    }
                    
                    let (current_node_new_boundary, current_node_new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                    Ok(ProcessedNodeUpdate {
                        new_hash: current_node_new_hash,
                        new_boundary_key: current_node_new_boundary,
                        split_info: split_to_propagate,
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
                        self.root_hash = Some(children[0].child_hash);
                        // TODO: GC old internal root node chunk?
                    }
                }
                Ok(key_was_actually_deleted) 
            }
            DeleteRecursionResult::Merged => {
                self.root_hash = None;
                // TODO: GC old root node chunk?
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

    // --- rebalance_borrow_from_left / right remain the same as the PREVIOUS version (with reinstated boundary updates) ---
    async fn rebalance_borrow_from_left(
         &mut self, children: &mut Vec<InternalEntry>, left_idx: usize, underflow_idx: usize
    ) -> Result<()> {
        let mut left_node = self.load_node(&children[left_idx].child_hash).await?;
        let mut underflow_node = self.load_node(&children[underflow_idx].child_hash).await?;
        match (&mut left_node, &mut underflow_node) {
            (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: underflow_entries, .. }) => {
                if let Some(borrowed_entry) = left_entries.pop() { underflow_entries.insert(0, borrowed_entry); } 
                else { return Err(ProllyError::InternalError("Attempted to borrow from empty left leaf sibling".to_string())); }
            }
            (Node::Internal { children: left_children, .. }, Node::Internal { children: underflow_children, .. }) => {
                 if let Some(borrowed_child_entry) = left_children.pop() { underflow_children.insert(0, borrowed_child_entry); } 
                 else { return Err(ProllyError::InternalError("Attempted to borrow from empty left internal sibling".to_string())); }
            }
            _ => return Err(ProllyError::InternalError("Sibling nodes have different types or levels during rebalance".to_string())),
        }
        let (new_left_boundary, new_left_hash) = self.store_node_and_get_key_hash_pair(&left_node).await?;
        let (new_underflow_boundary, new_underflow_hash) = self.store_node_and_get_key_hash_pair(&underflow_node).await?;
        children[left_idx].boundary_key = new_left_boundary; 
        children[left_idx].child_hash = new_left_hash;
        children[underflow_idx].boundary_key = new_underflow_boundary; // Boundary DOES change
        children[underflow_idx].child_hash = new_underflow_hash; 
        Ok(())
    }

     async fn rebalance_borrow_from_right(
         &mut self, children: &mut Vec<InternalEntry>, underflow_idx: usize, right_idx: usize
     ) -> Result<()> {
         let mut underflow_node = self.load_node(&children[underflow_idx].child_hash).await?;
         let mut right_node = self.load_node(&children[right_idx].child_hash).await?;
         match (&mut underflow_node, &mut right_node) {
             (Node::Leaf { entries: underflow_entries, .. }, Node::Leaf { entries: right_entries, .. }) => {
                if right_entries.is_empty() { return Err(ProllyError::InternalError("Attempted to borrow from empty right leaf sibling".to_string())); }
                let borrowed_entry = right_entries.remove(0); underflow_entries.push(borrowed_entry);
             }
             (Node::Internal { children: underflow_children, .. }, Node::Internal { children: right_children, .. }) => {
                 if right_children.is_empty() { return Err(ProllyError::InternalError("Attempted to borrow from empty right internal sibling".to_string())); }
                 let borrowed_child_entry = right_children.remove(0); underflow_children.push(borrowed_child_entry);
             }
              _ => return Err(ProllyError::InternalError("Sibling nodes have different types or levels during rebalance".to_string())),
         }
         let (new_underflow_boundary, new_underflow_hash) = self.store_node_and_get_key_hash_pair(&underflow_node).await?;
         let (new_right_boundary, new_right_hash) = self.store_node_and_get_key_hash_pair(&right_node).await?;
         children[underflow_idx].boundary_key = new_underflow_boundary; 
         children[underflow_idx].child_hash = new_underflow_hash;
         children[right_idx].boundary_key = new_right_boundary; // Boundary DOES change
         children[right_idx].child_hash = new_right_hash; 
         Ok(())
     }

    /// Helper to merge the node at `right_idx` into the node at `left_idx`.
    /// Modifies the left child node, updates the parent's entry for the left child,
    /// and removes the parent's entry for the right child from the `children` Vec.
    async fn merge_into_left_sibling( // Renamed for clarity
         &mut self,
         children: &mut Vec<InternalEntry>, // Parent's children list
         left_idx: usize,                   // Index of the node to merge into
         right_idx: usize,                  // Index of the node to merge from (will be removed)
    ) -> Result<()> {
        if left_idx + 1 != right_idx {
             return Err(ProllyError::InternalError(format!("Attempted to merge non-adjacent siblings: {} and {}", left_idx, right_idx)));
         }
        if right_idx >= children.len() {
             return Err(ProllyError::InternalError(format!("Attempted to merge with invalid right index: {}", right_idx)));
         }

        let left_hash = children[left_idx].child_hash;
        let right_hash = children[right_idx].child_hash; 

        // Load nodes
        let mut left_node = self.load_node(&left_hash).await?;
        let right_node = self.load_node(&right_hash).await?; // Consumed below

        // Perform merge
        match (&mut left_node, right_node) {
            (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: mut right_entries, .. }) => {
                left_entries.append(&mut right_entries); 
            }
            (Node::Internal { children: left_children, .. }, Node::Internal { children: mut right_children, .. }) => {
                 left_children.append(&mut right_children); 
            }
            _ => return Err(ProllyError::InternalError("Sibling nodes have different types or levels during merge".to_string())),
        }

        // Store merged left node
        let (new_left_boundary, new_left_hash) = self.store_node_and_get_key_hash_pair(&left_node).await?;

        // Update parent's entry for the left sibling
        children[left_idx].boundary_key = new_left_boundary;
        children[left_idx].child_hash = new_left_hash;

        // Remove the parent's entry for the right sibling *from the vec passed in*
        children.remove(right_idx);

        // TODO: Garbage Collection for right_hash chunk
        Ok(())
    }

    /// Helper to merge two adjacent siblings (`right_idx` into `left_idx`).
    /// Modifies the left child node, updates the parent's entry for the left child,
    /// and removes the parent's entry for the right child.
    async fn merge_siblings(
        &mut self,
        children: &mut Vec<InternalEntry>, // Parent's children list
        left_idx: usize,
        right_idx: usize,
   ) -> Result<()> {
       // Ensure indices are adjacent
       if left_idx + 1 != right_idx {
           return Err(ProllyError::InternalError(format!("Attempted to merge non-adjacent siblings: {} and {}", left_idx, right_idx)));
       }

       let left_hash = children[left_idx].child_hash;
       let right_hash = children[right_idx].child_hash; // Hash of node to remove

       // Load the nodes
       let mut left_node = self.load_node(&left_hash).await?;
       let right_node = self.load_node(&right_hash).await?;

       // Perform the merge based on node type
       match (&mut left_node, right_node) {
           (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: mut right_entries, .. }) => {
               left_entries.append(&mut right_entries);
               // Optional check if merged node exceeds MAX fanout - shouldn't happen if merge follows underflow rules
               // if left_entries.len() > self.config.target_fanout * 2 { // rough check
               //     // This indicates a potential logic error elsewhere or very skewed borrowing
               //     return Err(ProllyError::InternalError("Node exceeds max size after merge".to_string()));
               // }
           }
           (Node::Internal { children: left_children, .. }, Node::Internal { children: mut right_children, .. }) => {
                left_children.append(&mut right_children);
                // Optional check if merged node exceeds MAX fanout
           }
           _ => return Err(ProllyError::InternalError("Sibling nodes have different types or levels during merge".to_string())),
       }

       // Store the newly merged left node
       let (new_left_boundary, new_left_hash) = self.store_node_and_get_key_hash_pair(&left_node).await?;

       // Update the parent's entry for the left sibling
       children[left_idx].boundary_key = new_left_boundary;
       children[left_idx].child_hash = new_left_hash;

       // Remove the parent's entry for the right sibling
       children.remove(right_idx);

       // TODO: Garbage Collection - the node chunk identified by `right_hash` is now orphaned.
       // A separate GC process would be needed to find and delete such chunks from the store.

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

}
