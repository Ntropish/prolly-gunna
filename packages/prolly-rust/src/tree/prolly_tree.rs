// prolly-rust/src/tree/prolly_tree.rs

use std::sync::Arc;
use std::pin::Pin; 
use std::future::Future; 

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, LeafEntry, InternalEntry, ValueRepr};
use crate::store::ChunkStore;
use crate::chunk::chunk_node;


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

    async fn load_node(&self, hash: &Hash) -> Result<Node> {
        let bytes = self.store.get(hash).await?
            .ok_or_else(|| ProllyError::ChunkNotFound(*hash))?;
        Node::decode(&bytes)
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
    
    pub async fn get(&self, key: &Key) -> Result<Option<Value>> { // Public
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(None),
        };
        self.recursive_get_impl(current_root_hash, key.clone()).await
    }
    
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
                            match &entry.value {
                                ValueRepr::Inline(val) => Ok(Some(val.clone())),
                                ValueRepr::Chunked(data_hash) => {
                                    let value_bytes = self.store.get(data_hash).await?
                                        .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))?;
                                    Ok(Some(value_bytes))
                                }
                            }
                        }
                        Err(_) => Ok(None),
                    }
                }
                Node::Internal { children, .. } => {
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

    async fn prepare_value_repr(&self, value: Value) -> Result<ValueRepr> { // Private
        Ok(ValueRepr::Inline(value))
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
    pub async fn delete(&mut self, key: &Key) -> Result<bool> { // Public
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(false), // Key not found in empty tree
        };
        
        // Need root level to check if root leaf becomes empty
        let root_node = self.load_node(&current_root_hash).await?; 
        let root_level = root_node.level();

        let result = self.recursive_delete_impl(current_root_hash, key, root_level).await?;

        match result {
             DeleteRecursionResult::NotFound { .. } => {
                 // Key wasn't found anywhere. Root hash doesn't change.
                 Ok(false) 
             }
             DeleteRecursionResult::Updated(update_info) => {
                self.root_hash = Some(update_info.new_hash);
                
                // Check if root needs adjustment (e.g. internal with one child)
                // Load the node *after* potentially updating self.root_hash
                let potentially_new_root_node = self.load_node(&self.root_hash.unwrap()).await?;
                
                if let Node::Internal { ref children, .. } = potentially_new_root_node {
                    if children.len() == 1 { // Root degraded to single child
                        self.root_hash = Some(children[0].child_hash);
                        // TODO: GC old internal root node chunk?
                    }
                }
                // Note: Empty root leaf case is now handled by Merged result.
                
                Ok(true) // Key was found and deleted
            }
            DeleteRecursionResult::Merged => {
                // The root itself merged away (either empty leaf or internal with <2 children after merge). Tree is empty.
                self.root_hash = None;
                 // TODO: GC old root node chunk?
                Ok(true) // Key was found and deleted
            }
        }
    }

    // Recursive helper for deletion.
    fn recursive_delete_impl<'s>(
        &'s mut self,
        node_hash: Hash,
        key: &'s Key, // Use reference for key during descent
        level: u8,
    ) -> Pin<Box<dyn Future<Output = Result<DeleteRecursionResult>> + Send + 's>> {
        Box::pin(async move {
            let mut current_node_obj = self.load_node(&node_hash).await?;
            let mut key_found_and_deleted = false; // Track if the key was actually found at leaf level

             match &mut current_node_obj {
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                        Ok(index) => { // Key found
                            // TODO: Handle ValueRepr::Chunked - need to potentially delete value chunk(s)? Or rely on GC.
                            entries.remove(index); // << MUTATES entries here
    
                            // Now that mutation is done, check the state *before* storing
                            if entries.is_empty() {
                                 // If a leaf becomes empty (root or not), it effectively merges away.
                                 // No need to store the empty node.
                                 return Ok(DeleteRecursionResult::Merged); 
                            } else {
                                // Leaf modified but not empty. Now we can store it.
                                // The mutable borrow of `entries` is no longer needed for the check.
                                // We pass an immutable borrow of `current_node_obj` for storing.
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{ new_hash, new_boundary_key: new_boundary, split_info: None }))
                            }
                        }
                        Err(_) => { // Key not found
                            // No change to the node. Return NotFound with original hash/key.
                            // Need the boundary key, but avoid storing.
                            let boundary_key = match entries.last() {
                                 Some(e) => e.key.clone(),
                                 None => return Err(ProllyError::InternalError("Cannot get boundary key from empty leaf (key not found path)".to_string())), // Should not be empty here
                            };
                            Ok(DeleteRecursionResult::NotFound{ node_hash, boundary_key })
                        }
                    }
                }
                Node::Internal { children, .. } => {
                    // --- STEP 1: Find the index ---
                    let child_idx_to_descend = { // Create a block scope to find the index
                        let mut idx_found = children.len() - 1; 
                        for (idx, child_entry) in children.iter().enumerate() {
                            if key <= &child_entry.boundary_key { 
                                idx_found = idx;
                                break;
                            }
                        }
                        idx_found // Return the index from the block
                    };
                
                    // --- STEP 2: Get child info & Recurse ---
                    let child_hash = children[child_idx_to_descend].child_hash; 
                    let child_level = level - 1;
                    let child_delete_result = self.recursive_delete_impl(child_hash, key, child_level).await?;
                
                    // --- STEP 3: Process Result (child_idx_to_descend is definitely in scope here) ---
                    match child_delete_result {
                        DeleteRecursionResult::NotFound { .. } => { /* ... as before ... */ 
                             let boundary_key = children.last().map(|ce| ce.boundary_key.clone())
                                 .ok_or_else(|| ProllyError::InternalError("Cannot get boundary key from empty internal node (not found path)".to_string()))?;
                             Ok(DeleteRecursionResult::NotFound { node_hash, boundary_key })
                        }
                        DeleteRecursionResult::Updated(child_update) => {
                             // Update using the index
                             children[child_idx_to_descend].child_hash = child_update.new_hash;
                             children[child_idx_to_descend].boundary_key = child_update.new_boundary_key;
                             
                             let child_node = self.load_node(&child_update.new_hash).await?;
                             let needs_rebalance = child_node.is_underflow(&self.config); 
                
                             if needs_rebalance {
                                 // Pass the index
                                 self.handle_underflow(children, child_idx_to_descend).await?; 
                                 if children.is_empty() { return Ok(DeleteRecursionResult::Merged); }
                                 // Recheck underflow *after* handle_underflow possibly merged siblings
                                 if level > 0 && children.len() < self.config.min_fanout { return Ok(DeleteRecursionResult::Merged); }
                             }
                            
                            let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                            Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{ new_hash, new_boundary_key: new_boundary, split_info: None }))
                        }
                        DeleteRecursionResult::Merged => {
                             // Use the index
                            children.remove(child_idx_to_descend); 
                            
                            if children.is_empty() { return Ok(DeleteRecursionResult::Merged); }
                
                            let needs_merging = level > 0 && current_node_obj.is_underflow(&self.config); 
                
                            if needs_merging { 
                                 Ok(DeleteRecursionResult::Merged) 
                            } else {
                                let (new_boundary, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                                Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate{ new_hash, new_boundary_key: new_boundary, split_info: None }))
                            }
                        }
                    }
                }
            }
            // The key_found_and_deleted flag isn't fully utilized here yet to return false from public delete.
        })
    }

    /// Handles underflow at a given child index in an internal node's children list.
    /// Tries to borrow from siblings first, then merges if necessary.
    /// Modifies the `children` Vec in place.
    async fn handle_underflow(
        &mut self,
        children: &mut Vec<InternalEntry>, // Children of the parent node
        underflow_child_idx: usize,        // Index of the child that is underflow
    ) -> Result<()> {
        
        // Try borrowing from left sibling
        if underflow_child_idx > 0 {
            let left_sibling_idx = underflow_child_idx - 1;
            // Check if left sibling has enough entries to lend one
            let left_sibling_node = self.load_node(&children[left_sibling_idx].child_hash).await?;
            if left_sibling_node.num_entries() > self.config.min_fanout {
                 // Perform borrow from left (rebalance)
                 self.rebalance_borrow_from_left(children, left_sibling_idx, underflow_child_idx).await?;
                 return Ok(()); // Rebalanced successfully
            }
        }

        // Try borrowing from right sibling
        if underflow_child_idx + 1 < children.len() {
             let right_sibling_idx = underflow_child_idx + 1;
             let right_sibling_node = self.load_node(&children[right_sibling_idx].child_hash).await?;
             if right_sibling_node.num_entries() > self.config.min_fanout {
                  // Perform borrow from right (rebalance)
                  self.rebalance_borrow_from_right(children, underflow_child_idx, right_sibling_idx).await?;
                  return Ok(()); // Rebalanced successfully
             }
        }

        // Cannot borrow, must merge. Prefer merging with left sibling if possible.
        if underflow_child_idx > 0 {
            // Merge with left sibling
            self.merge_siblings(children, underflow_child_idx - 1, underflow_child_idx).await?;
        } else {
            // Must merge with right sibling (underflow_child_idx must be 0 here)
            self.merge_siblings(children, underflow_child_idx, underflow_child_idx + 1).await?;
        }

        Ok(())
    }

    /// Helper to rebalance by borrowing an entry from the left sibling.
    async fn rebalance_borrow_from_left(
         &mut self,
         _children: &mut Vec<InternalEntry>,
         _left_idx: usize,
         _underflow_idx: usize
    ) -> Result<()> {
        // 1. Load left sibling node and underflow node.
        // 2. Move the *last* entry/child from left sibling to the *start* of the underflow node.
        // 3. Update boundary keys in the parent (children Vec). The boundary key between left and underflow needs to be updated
        //    (it will now be the new max key of the left sibling).
        // 4. Re-store both modified child nodes.
        unimplemented!("rebalance_borrow_from_left not implemented");
        // Ok(())
    }

    /// Helper to rebalance by borrowing an entry from the right sibling.
     async fn rebalance_borrow_from_right(
         &mut self,
         _children: &mut Vec<InternalEntry>,
         _underflow_idx: usize,
         _right_idx: usize
     ) -> Result<()> {
        // 1. Load underflow node and right sibling node.
        // 2. Move the *first* entry/child from right sibling to the *end* of the underflow node.
        // 3. Update boundary keys in the parent (children Vec). The boundary key for the underflow node needs to be updated
        //    (it will now be the key borrowed from the right sibling). The boundary key for the right sibling might also change if its first element defined it.
        // 4. Re-store both modified child nodes.
         unimplemented!("rebalance_borrow_from_right not implemented");
        // Ok(())
     }

    /// Helper to merge two adjacent siblings.
    /// The node at `right_idx` is merged into the node at `left_idx`.
    /// The entry for `right_idx` is removed from the parent's `children` Vec.
    async fn merge_siblings(
         &mut self,
         children: &mut Vec<InternalEntry>,
         left_idx: usize,
         right_idx: usize,
    ) -> Result<()> {
        // 1. Load left and right sibling nodes.
        // 2. Append all entries/children from the right sibling node into the left sibling node.
        //    (For internal nodes, might need to include the "separator key" from the parent conceptually).
        // 3. Store the merged left sibling node (its hash and boundary key will change).
        // 4. Update the parent's entry for the left sibling (`children[left_idx]`) with the new hash and boundary key.
        // 5. Remove the parent's entry for the right sibling (`children[right_idx]`).
        // 6. TODO: Ideally, delete the node chunk for the (now unreferenced) right sibling? Or rely on GC.
         unimplemented!("merge_siblings not implemented");
        // Ok(())
    }

    pub async fn commit(&mut self) -> Result<Option<Hash>> { // Public
        Ok(self.root_hash)
    }
}