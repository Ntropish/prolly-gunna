// ProllyTree Cursor Module
use std::sync::Arc;
use std::cmp::Ordering;
use std::collections::VecDeque;
use log::warn; 

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr, LeafEntry};
use crate::store::ChunkStore;
use crate::ScanArgs;
use super::ProllyTree; // Access sibling module



/// Represents an ongoing traversal over the key-value pairs in a ProllyTree.
#[derive(Debug, Clone)]
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

    // load_value_repr_from_store, advance_cursor_path_to_next_leaf_static, 
    // advance_cursor_path_to_prev_leaf_static remain as previously corrected.
    async fn load_value_repr_from_store(&self, value_repr: &ValueRepr) -> Result<Value> {
        match value_repr {
            ValueRepr::Inline(val) => Ok(val.clone()),
            ValueRepr::Chunked(data_hash) => {
                self.store.get(data_hash).await?
                    .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))
            }
            ValueRepr::ChunkedSequence { chunk_hashes, total_size } => {
                let mut reconstructed_value = Vec::with_capacity(*total_size as usize);
                for chunk_hash in chunk_hashes {
                    let chunk_bytes = self.store.get(chunk_hash).await?
                        .ok_or_else(|| ProllyError::ChunkNotFound(*chunk_hash))?;
                    reconstructed_value.extend_from_slice(&chunk_bytes);
                }
                if reconstructed_value.len() as u64 != *total_size {
                     warn!("Cursor/LoadValue: Reconstructed value size mismatch. Expected {}, got {}.", total_size, reconstructed_value.len());
                }
                Ok(reconstructed_value)
            }
        }
    }

    async fn advance_cursor_path_to_next_leaf_static(
        path: &mut Vec<(Hash, Node, usize)>,
        store: &Arc<S>
    ) -> Result<bool> {
        if path.is_empty() { return Ok(false); }
        loop {
            let (_popped_hash, _popped_node, popped_idx_in_parent) = match path.pop() {
                Some(info) => info, None => return Ok(false),
            };
            let (_parent_hash, parent_node_ref, _parent_parent_idx) = match path.last() {
                 Some(parent_info) => parent_info, None => return Ok(false),
            };
            let parent_node_cloned = parent_node_ref.clone();
            if let Node::Internal { children, .. } = parent_node_cloned {
                 let next_sibling_idx_in_parent = popped_idx_in_parent + 1;
                 if next_sibling_idx_in_parent < children.len() {
                     let mut current_hash_descend = children[next_sibling_idx_in_parent].child_hash;
                     let mut current_idx_in_its_parent_descend = next_sibling_idx_in_parent;
                     loop {
                        let current_node_obj_descend = Node::decode(&store.get(&current_hash_descend).await?.ok_or_else(|| ProllyError::ChunkNotFound(current_hash_descend))?)?;
                        let is_leaf = matches!(current_node_obj_descend, Node::Leaf { .. });
                        path.push((current_hash_descend, current_node_obj_descend.clone(), current_idx_in_its_parent_descend));
                        if is_leaf { return Ok(true); }
                        match current_node_obj_descend {
                              Node::Internal { children: c_descend, .. } => {
                                   if c_descend.is_empty() { return Err(ProllyError::InternalError("Empty internal node during static advance".to_string())); }
                                   current_idx_in_its_parent_descend = 0;
                                   current_hash_descend = c_descend[0].child_hash;
                              }
                               Node::Leaf { .. } => unreachable!(),
                         }
                     }
                 } else { continue; }
            } else { return Err(ProllyError::InternalError("Cursor path parent not internal during static advance".to_string())); }
        }
    }

    async fn advance_cursor_path_to_prev_leaf_static(
        path: &mut Vec<(Hash, Node, usize)>,
        store: &Arc<S>
    ) -> Result<bool> {
        if path.is_empty() { return Ok(false); }
        loop {
            let (_popped_hash, _popped_node, popped_idx_in_parent) = match path.pop() {
                Some(info) => info, None => return Ok(false),
            };
            let (_parent_hash, parent_node_ref, _parent_parent_idx) = match path.last() {
                 Some(parent_info) => parent_info, None => return Ok(false),
            };
            let parent_node_cloned = parent_node_ref.clone();
            if let Node::Internal { children, .. } = parent_node_cloned {
                 if popped_idx_in_parent == usize::MAX { return Ok(false); }
                 let prev_sibling_idx_in_parent = popped_idx_in_parent.checked_sub(1);

                 if let Some(prev_idx) = prev_sibling_idx_in_parent {
                    // prev_idx < children.len() is inherently true if Some(prev_idx)
                    let mut current_hash_descend = children[prev_idx].child_hash;
                    let mut current_idx_in_its_parent_descend = prev_idx;
                    loop {
                        let current_node_obj_descend = Node::decode(&store.get(&current_hash_descend).await?.ok_or_else(|| ProllyError::ChunkNotFound(current_hash_descend))?)?;
                        let is_leaf = matches!(current_node_obj_descend, Node::Leaf { .. });
                        path.push((current_hash_descend, current_node_obj_descend.clone(), current_idx_in_its_parent_descend));
                        if is_leaf { return Ok(true); }
                        match current_node_obj_descend {
                            Node::Internal { children: c_descend, .. } => {
                                if c_descend.is_empty() { return Err(ProllyError::InternalError("Empty internal node during prev_leaf advance".to_string())); }
                                current_idx_in_its_parent_descend = c_descend.len() - 1;
                                current_hash_descend = c_descend[current_idx_in_its_parent_descend].child_hash;
                            }
                            Node::Leaf { .. } => unreachable!(),
                        }
                    }
                 } else { continue; } 
            } else { return Err(ProllyError::InternalError("Cursor path parent not internal during prev_leaf advance".to_string())); }
        }
    }

    pub(crate) async fn new_for_scan(
        tree: &ProllyTree<S>,
        args: &ScanArgs,
    ) -> Result<Self> {
        let store = Arc::clone(&tree.store);
        let config = tree.config.clone();
        let mut path: Vec<(Hash, Node, usize)> = Vec::new();
        // Initialize current_leaf_entry_idx to a sensible default.
        // It will be precisely set by the logic below.
        let mut current_leaf_entry_idx: usize = if args.reverse { usize::MAX } else { 0 };
        let mut remaining_offset = args.offset;

        if tree.root_hash.is_none() {
            // For an empty tree, the cursor is effectively at its "end" or "before beginning".
            return Ok(Self { store, config, path, current_leaf_entry_idx });
        }

        let mut current_hash = tree.root_hash.unwrap();
        let mut current_node_obj = tree.load_node(&current_hash).await?;
        path.push((current_hash, current_node_obj.clone(), usize::MAX));

        let primary_bound_for_initial_descend: Option<&Key> = if !args.reverse {
            args.start_bound.as_ref()
        } else {
            args.end_bound.as_ref()
        };

        // Phase 1: Descend to the initial candidate leaf based on bounds
        while let Node::Internal { children, .. } = &current_node_obj {
            if children.is_empty() {
                return Ok(Self { store, config, path, current_leaf_entry_idx });
            }
            let child_idx_to_descend: usize = if let Some(key_to_find) = primary_bound_for_initial_descend {
                if !args.reverse {
                    children.binary_search_by_key(key_to_find, |entry| entry.boundary_key.clone())
                        .map_or_else(|idx| idx, |idx| if args.start_inclusive { idx } else { idx.saturating_add(1) })
                        .min(children.len().saturating_sub(1))
                } else {
                    match children.binary_search_by_key(key_to_find, |entry| entry.boundary_key.clone()) {
                        Ok(idx) => idx,
                        Err(idx) => idx.min(children.len().saturating_sub(1)),
                    }
                }
            } else {
                if !args.reverse { 0 } else { children.len() - 1 }
            };
            
            if child_idx_to_descend >= children.len() { // Should be caught by .min() above
                 // This means key_to_find is beyond all children boundaries (for forward scan)
                 // Or before all children boundaries (for reverse scan if logic was different)
                 // Take the last/first child respectively and let offset logic figure it out.
                let actual_child_idx = if !args.reverse { children.len()-1} else {0};
                current_hash = children[actual_child_idx].child_hash;
                current_node_obj = tree.load_node(&current_hash).await?;
                path.push((current_hash, current_node_obj.clone(), actual_child_idx));
                break; // Stop descending further based on bounds
            }

            current_hash = children[child_idx_to_descend].child_hash;
            current_node_obj = tree.load_node(&current_hash).await?;
            path.push((current_hash, current_node_obj.clone(), child_idx_to_descend));
        }

        // Phase 2: Apply offset (count-based traversal)
        // This logic needs to be careful not to consume `path` prematurely if it's short.
        if path.len() > 1 { // Only if we have internal nodes to traverse for offset
            let mut nodes_to_process_for_offset = path.drain(1..).collect::<VecDeque<_>>(); // Nodes below root
            path.truncate(1); // Keep root in path, rebuild from there
        }
        
        // At this point, path should lead to the correct leaf, and remaining_offset is the offset within it.
        if let Some((_, final_leaf_node, _)) = path.last() {
            if let Node::Leaf { entries, .. } = final_leaf_node {
                if !args.reverse {
                    if remaining_offset == u64::MAX || remaining_offset >= entries.len() as u64 { // u64::MAX was my OOB signal
                        current_leaf_entry_idx = entries.len(); // Position at end
                    } else {
                        current_leaf_entry_idx = remaining_offset as usize;
                    }
                } else { // Reverse
                    if remaining_offset == u64::MAX { // Signal OOB (before start)
                        current_leaf_entry_idx = usize::MAX;
                    } else if remaining_offset >= entries.len() as u64 { // Offset too large from end
                        current_leaf_entry_idx = usize::MAX; // Position before start
                    } else {
                        current_leaf_entry_idx = entries.len().saturating_sub(1).saturating_sub(remaining_offset as usize);
                    }
                }
            } else { /* Should be a leaf if path is not empty */ 
                // This can happen if tree is empty or offset is huge.
                // Initialize based on direction if path is empty.
                if path.is_empty() { // This should have been caught by root_hash.is_none()
                     current_leaf_entry_idx = if args.reverse { usize::MAX } else { 0 };
                } else { // Path not empty, but last element isn't leaf - internal error
                    return Err(ProllyError::InternalError("Scan offset calculation did not end in a leaf node.".to_string()));
                }
            }
        } else { // Path is empty, implies empty tree, already handled.
             current_leaf_entry_idx = if args.reverse { usize::MAX } else { 0 };
        }


        // Final inclusivity adjustment for the first item if no offset skipping occurred before this point.
        if args.offset == 0 {
            if let Some((_, Node::Leaf { entries, .. }, _)) = path.last() {
                 if !args.reverse {
                    if let Some(sb_val) = &args.start_bound {
                        // If current_leaf_entry_idx is valid and points to start_bound but not inclusive
                        if current_leaf_entry_idx < entries.len() && !args.start_inclusive && entries[current_leaf_entry_idx].key == *sb_val {
                            current_leaf_entry_idx = current_leaf_entry_idx.saturating_add(1);
                        }
                    }
                } else { // Reverse
                    if let Some(eb_val) = &args.end_bound {
                        // If current_leaf_entry_idx is valid and points to end_bound but not inclusive
                        if current_leaf_entry_idx != usize::MAX && current_leaf_entry_idx < entries.len() &&
                           !args.end_inclusive && entries[current_leaf_entry_idx].key == *eb_val {
                            if current_leaf_entry_idx == 0 { current_leaf_entry_idx = usize::MAX; }
                            else { current_leaf_entry_idx = current_leaf_entry_idx.saturating_sub(1); }
                        }
                    }
                }
            }
        }
        Ok(Self { store, config, path, current_leaf_entry_idx })
    }

    // next_in_scan needs to be robust
    pub async fn next_in_scan(&mut self, args: &ScanArgs) -> Result<Option<(Key, Value)>> {
        loop { 
            let current_path_len = self.path.len();
            if current_path_len == 0 { return Ok(None); } // Empty path means nothing to scan

            let (_leaf_hash, current_leaf_node, _idx_in_parent) = self.path.last().unwrap(); // Safe due to check above

            if let Node::Leaf { entries, .. } = current_leaf_node {
                let entry_opt: Option<&LeafEntry> = if !args.reverse {
                    if self.current_leaf_entry_idx >= entries.len() { None }
                    else { entries.get(self.current_leaf_entry_idx) }
                } else { // Reverse
                    if self.current_leaf_entry_idx == usize::MAX || self.current_leaf_entry_idx >= entries.len() { None }
                    else { entries.get(self.current_leaf_entry_idx) }
                };

                if let Some(entry) = entry_opt {
                    let key_ref = &entry.key;
                    // Boundary checks
                    if !args.reverse {
                        if let Some(ref eb) = args.end_bound {
                            match key_ref.cmp(eb) {
                                Ordering::Greater => return Ok(None), 
                                Ordering::Equal if !args.end_inclusive => return Ok(None), 
                                _ => {}
                            }
                        }
                    } else { 
                        if let Some(ref sb) = args.start_bound { 
                            match key_ref.cmp(sb) {
                                Ordering::Less => return Ok(None), 
                                Ordering::Equal if !args.start_inclusive => return Ok(None),
                                _ => {}
                            }
                        }
                    }

                    let value = self.load_value_repr_from_store(&entry.value).await?;

                    if !args.reverse {
                        self.current_leaf_entry_idx += 1;
                    } else {
                        if self.current_leaf_entry_idx == 0 { self.current_leaf_entry_idx = usize::MAX; }
                        else { self.current_leaf_entry_idx -= 1; }
                    }
                    return Ok(Some((entry.key.clone(), value)));

                } else { // End of current leaf in the scan direction
                    let advanced: bool = if !args.reverse {
                        Self::advance_cursor_path_to_next_leaf_static(&mut self.path, &self.store).await?
                    } else {
                        Self::advance_cursor_path_to_prev_leaf_static(&mut self.path, &self.store).await?
                    };
                    
                    if !advanced { return Ok(None); } 

                    if let Some((_, new_leaf_node, _)) = self.path.last() {
                        if let Node::Leaf{entries: new_entries, ..} = new_leaf_node {
                            self.current_leaf_entry_idx = if !args.reverse { 0 } 
                                                          else { new_entries.len().saturating_sub(1) };
                        } else { return Err(ProllyError::InternalError("Advanced cursor path did not end in a leaf".to_string())); }
                    } else { return Ok(None); /* Should be caught by !advanced */ }
                }
            } else { return Err(ProllyError::InternalError("Cursor path top was not a LeafNode during next_in_scan".to_string())); }
        } 
    }
    // Original instance method, can now call the static helper
    async fn advance_to_next_leaf(&mut self) -> Result<bool> {
        let advanced = Self::advance_cursor_path_to_next_leaf_static(&mut self.path, &self.store).await?;
        if advanced {
            self.current_leaf_entry_idx = 0; // Reset for the new leaf
        }
        Ok(advanced)
    }

}