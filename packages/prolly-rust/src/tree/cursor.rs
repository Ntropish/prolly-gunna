// ProllyTree Cursor Module
use std::sync::Arc;

use log::warn; 

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr};
use crate::store::ChunkStore;
use super::ProllyTree; // Access sibling module

/// Represents an ongoing traversal over the key-value pairs in a ProllyTree.
#[derive(Debug)]
pub struct Cursor<S: ChunkStore> {
    /// Reference to the store to load nodes.
    store: Arc<S>,
    /// Tree configuration (e.g., for max inline size, though less relevant for cursor).
    config: TreeConfig, // Maybe only store Arc<S> is needed? Depends on value reconstruction. Let's keep config for now.
    
    /// Stack representing the path from the root to the current leaf.
    /// Each tuple: (node_hash, loaded_node_object, index_in_parent)
    /// The last element is the current leaf node.
    /// usize is the index *within the parent's children list* that points to this node. For root, index is usize::MAX or similar sentinel.
    path: Vec<(Hash, Node, usize)>,

    /// The index of the *next* entry to yield within the current leaf node.
    current_leaf_entry_idx: usize,

    // Future: Add start_bound and end_bound for range iteration
    // start_bound: Option<Key>,
    // end_bound: Option<Key>,
}

impl<S: ChunkStore> Cursor<S> {
    /// Creates a new cursor, positioned before the first element.
    /// Requires navigating down the leftmost path to the first leaf.
    pub(crate) async fn new_at_start(tree: &ProllyTree<S>) -> Result<Self> {
        let store = Arc::clone(&tree.store);
        let config = tree.config.clone();
        let mut path = Vec::new();
        let current_leaf_entry_idx = 0;

        if let Some(root_hash) = tree.root_hash {
            let mut current_hash = root_hash;
            let mut parent_idx = usize::MAX; // Sentinel for root

            loop {
                let current_node = tree.load_node(&current_hash).await?;
                let is_leaf = matches!(current_node, Node::Leaf { .. });
                
                path.push((current_hash, current_node.clone(), parent_idx)); // Clone node into path

                if is_leaf {
                    break; // Reached the leftmost leaf
                }

                match current_node {
                    Node::Internal { children, .. } => {
                        if children.is_empty() {
                            // Invalid state: internal node with no children reached during descent
                            return Err(ProllyError::InternalError("Empty internal node found during cursor init".to_string()));
                        }
                        // Descend to the first child
                        parent_idx = 0;
                        current_hash = children[0].child_hash;
                    }
                    Node::Leaf { .. } => unreachable!(), // Already handled by is_leaf check
                }
            }
        } else {
            // Empty tree, path remains empty, index 0
        }

        Ok(Self { store, config, path, current_leaf_entry_idx })
    }

    /// Creates a new cursor positioned at or after the given key.
    /// Requires navigating down the tree to find the relevant leaf and position.
    pub(crate) async fn new_at_key(tree: &ProllyTree<S>, start_key: &Key) -> Result<Self> {
         let store = Arc::clone(&tree.store);
         let config = tree.config.clone();
         let mut path = Vec::new();
         let mut current_leaf_entry_idx = 0; // Will be set precisely later

         if let Some(root_hash) = tree.root_hash {
            let mut current_hash = root_hash;
            let mut parent_idx_stack = Vec::new(); // Track index chosen at each level

            loop {
                let current_node = tree.load_node(&current_hash).await?;
                 let current_parent_idx = parent_idx_stack.last().copied().unwrap_or(usize::MAX);
                 path.push((current_hash, current_node.clone(), current_parent_idx));

                match current_node {
                    Node::Leaf { entries, .. } => {
                         // Find the index of the first entry >= start_key
                         match entries.binary_search_by(|e| e.key.as_slice().cmp(start_key.as_slice())) {
                             Ok(idx) => current_leaf_entry_idx = idx,      // Exact match
                             Err(idx) => current_leaf_entry_idx = idx, // First element greater than key
                         }
                         break; // Reached target leaf
                    }
                    Node::Internal { children, .. } => {
                         if children.is_empty() {
                             // Reached empty internal node? Error or indicates end of range?
                              return Err(ProllyError::InternalError("Empty internal node found during cursor seek".to_string()));
                         }
                         // Find child to descend into
                         let mut child_idx_to_descend = children.len() - 1; 
                         for (idx, child_entry) in children.iter().enumerate() {
                             if start_key <= &child_entry.boundary_key { 
                                 child_idx_to_descend = idx;
                                 break;
                             }
                         }
                         parent_idx_stack.push(child_idx_to_descend);
                         current_hash = children[child_idx_to_descend].child_hash;
                    }
                }
            }
        }
         // If tree is empty or key is > all keys, path might be empty or point past last element

         Ok(Self { store, config, path, current_leaf_entry_idx })
    }


    /// Advances the cursor and returns the next key-value pair.
    /// Returns `Ok(None)` when iteration is finished.
    pub async fn next(&mut self) -> Result<Option<(Key, Value)>> {
        loop {
            // Get current leaf node from the path stack
            let (_leaf_hash, current_leaf_node, _) = match self.path.last() {
                Some(leaf_info) => leaf_info,
                None => return Ok(None), // Path is empty, iteration finished or tree empty
            };

            if let Node::Leaf { entries, .. } = current_leaf_node {
                // Try to get the next entry from the current leaf
                if let Some(entry) = entries.get(self.current_leaf_entry_idx) {
                    // Increment index for next call *before* potentially long value reconstruction
                    self.current_leaf_entry_idx += 1;

                    // Reconstruct value if needed
                    let value = match &entry.value {
                        ValueRepr::Inline(val) => val.clone(),
                        ValueRepr::Chunked(data_hash) => {
                            self.store.get(data_hash).await?
                                .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))?
                        }
                        ValueRepr::ChunkedSequence { chunk_hashes, total_size } => {
                            let mut reconstructed_value = Vec::with_capacity(*total_size as usize);
                            for chunk_hash in chunk_hashes {
                                let chunk_bytes = self.store.get(chunk_hash).await?
                                    .ok_or_else(|| ProllyError::ChunkNotFound(*chunk_hash))?;
                                reconstructed_value.extend_from_slice(&chunk_bytes);
                            }
                             if reconstructed_value.len() as u64 != *total_size {
                                warn!("Cursor: Reconstructed value size mismatch for key {:?}. Expected {}, got {}.", entry.key, total_size, reconstructed_value.len());
                                // Consider returning error? Or just potentially bad data?
                             }
                            reconstructed_value
                        }
                    };
                    // Return the found key-value pair
                    return Ok(Some((entry.key.clone(), value)));
                } else {
                    // Reached end of current leaf node, try to move to the next one
                    if !self.advance_to_next_leaf().await? {
                         // No more leaves, iteration finished
                         return Ok(None);
                    }
                    // If advance succeeded, the loop continues and will read from the new leaf/index
                }
            } else {
                // Should not happen if path logic is correct - path should always end in a leaf
                return Err(ProllyError::InternalError("Cursor path did not end in a leaf node".to_string()));
            }
        }
    }

    /// Internal helper to move the cursor state to the start of the next leaf node.
    /// Returns true if successful, false if there are no more leaves.
    async fn advance_to_next_leaf(&mut self) -> Result<bool> {
        if self.path.is_empty() { return Ok(false); } 

        loop { // Outer loop to ascend the tree
            // Pop the node we just finished iterating through (or a parent we couldn't find siblings for)
            let (_popped_hash, _popped_node, popped_idx_in_parent) = match self.path.pop() {
                Some(info) => info,
                None => return Ok(false), // Should only happen if path was initially empty? Safety check.
            };

            // Look at the new top of the stack - this is the parent of the node we just popped.
            let (_parent_hash, parent_node, _parent_parent_idx) = match self.path.last() {
                 Some(parent_info) => parent_info, 
                 None => return Ok(false), // We just popped the root node, iteration is finished.
            };
            
            // Use the index of the node we *popped* relative to the current parent.
            let parent_idx_of_popped_node = popped_idx_in_parent; 

            if let Node::Internal { children, .. } = parent_node {
                 // Calculate the index of the potential next sibling *in the parent*.
                 let next_sibling_idx_in_parent = parent_idx_of_popped_node + 1;

                 if next_sibling_idx_in_parent < children.len() { 
                     // Found a next sibling in this parent, descend down its leftmost path
                     let mut current_hash = children[next_sibling_idx_in_parent].child_hash; 
                     // The index of this first sibling node *within its parent (parent_node)* is next_sibling_idx_in_parent
                     let mut current_idx_in_its_parent = next_sibling_idx_in_parent; 

                     loop { // Inner loop to descend to the leftmost leaf of the sibling subtree
                        // Load node using the cursor's store
                        let current_node_bytes = self.store.get(&current_hash).await
                            .map_err(|e| { warn!("Store error during cursor advance: {}", e); e })? 
                            .ok_or_else(|| {
                                warn!("Chunk not found during cursor advance: {:?}", current_hash);
                                ProllyError::ChunkNotFound(current_hash)
                            })?;
                        let current_node_obj = Node::decode(&current_node_bytes)
                            .map_err(|e| { warn!("Decode error during cursor advance: {}", e); ProllyError::from(e) })?;
                            
                        let is_leaf = matches!(current_node_obj, Node::Leaf { .. });

                        // Push this node onto the path with its correct index relative to *its* parent
                        self.path.push((current_hash, current_node_obj.clone(), current_idx_in_its_parent));

                        if is_leaf {
                             self.current_leaf_entry_idx = 0; // Reset index for the new leaf
                             return Ok(true); // Found the next leaf! Exit function successfully.
                        }

                        // If not leaf, must be internal, descend left
                        match current_node_obj {
                              Node::Internal { children: C, .. } => {
                                   if C.is_empty() { return Err(ProllyError::InternalError("Empty internal node during advance".to_string())); }
                                   // For the *next* node down (C[0]), its index in *this* node (its parent) is 0
                                   current_idx_in_its_parent = 0; 
                                   current_hash = C[0].child_hash; // Update hash for next inner loop iteration
                              }
                               Node::Leaf { .. } => unreachable!("Should have returned Ok(true) if leaf"),
                         }
                     } // End inner descent loop
                 } else {
                      // No more siblings in *this* parent, continue outer loop to pop parent
                      continue; 
                 }

            } else {
                 // Parent wasn't internal? Path logic error, should not happen if tree is well-formed.
                 return Err(ProllyError::InternalError("Cursor path contained non-Internal node as parent".to_string()));
            }
        } // End outer ascent loop
    }
}