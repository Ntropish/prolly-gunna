// ProllyTree Cursor Module
use std::sync::Arc;
use std::cmp::Ordering;
use log::warn; 

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr, LeafEntry};
use crate::store::ChunkStore;
use crate::tree::ScanArgs;
use super::ProllyTree; // Access sibling module



/// Represents an ongoing traversal over the key-value pairs in a ProllyTree.
#[derive(Debug, Clone)]
pub struct Cursor<S: ChunkStore> {
    /// Reference to the store to load nodes.
    store: Arc<S>,
    /// Tree configuration (e.g., for max inline size, though less relevant for cursor).
    #[allow(dead_code)]
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
        let mut current_leaf_entry_idx: usize = if args.reverse { usize::MAX } else { 0 };

        if tree.root_hash.is_none() {
            return Ok(Self { store, config, path, current_leaf_entry_idx });
        }

        let mut current_hash = tree.root_hash.unwrap();
        let mut current_node_obj = tree.load_node(&current_hash).await?;
        path.push((current_hash, current_node_obj.clone(), usize::MAX));

        // --- Phase 1: Initial descent based on primary bound (start_bound for fwd, start_bound for rev initial target) ---
        let primary_bound_for_initial_descend: Option<&Key> = if !args.reverse {
            args.start_bound.as_ref()
        } else {
            args.start_bound.as_ref() // For reverse, we also descend towards start_bound (upper limit)
                                      // then adjust index to be *before* it if exclusive.
        };

        if let Some(key_to_find_in_descent) = primary_bound_for_initial_descend {
            while let Node::Internal { children, .. } = &current_node_obj {
                if children.is_empty() { break; }
                let child_idx_to_descend = children
                    .binary_search_by_key(key_to_find_in_descent, |entry| entry.boundary_key.clone())
                    .map_or_else(|idx| idx, |idx| idx)
                    .min(children.len().saturating_sub(1));
                
                current_hash = children[child_idx_to_descend].child_hash;
                current_node_obj = tree.load_node(&current_hash).await?;
                path.push((current_hash, current_node_obj.clone(), child_idx_to_descend));
            }
            if let Node::Leaf { entries, .. } = &current_node_obj {
                if !args.reverse {
                    match entries.binary_search_by_key(key_to_find_in_descent, |e| e.key.clone()) {
                        Ok(idx) => current_leaf_entry_idx = idx,
                        Err(idx) => current_leaf_entry_idx = idx,
                    }
                } else { // Reverse scan, initially positioned relative to start_bound (upper)
                    match entries.binary_search_by_key(key_to_find_in_descent, |e| e.key.clone()) {
                        Ok(idx) => current_leaf_entry_idx = idx,
                        Err(idx) => current_leaf_entry_idx = idx.saturating_sub(1),
                    }
                    if entries.is_empty() { current_leaf_entry_idx = usize::MAX; }
                    else if current_leaf_entry_idx >= entries.len() { current_leaf_entry_idx = entries.len().saturating_sub(1); }
                }
            }
        } else { // No primary bound, descend to first/last leaf
            while let Node::Internal { children, .. } = &current_node_obj {
                 if children.is_empty() { break; }
                 let child_idx_to_descend = if !args.reverse { 0 } else { children.len() - 1 };
                 current_hash = children[child_idx_to_descend].child_hash;
                 current_node_obj = tree.load_node(&current_hash).await?;
                 path.push((current_hash, current_node_obj.clone(), child_idx_to_descend));
            }
            if args.reverse {
                if let Node::Leaf{ entries, .. } = &current_node_obj {
                    current_leaf_entry_idx = entries.len().saturating_sub(1);
                    if entries.is_empty() { current_leaf_entry_idx = usize::MAX; }
                } else { current_leaf_entry_idx = usize::MAX; }
            } // Forward current_leaf_entry_idx is already 0
        }

        // --- Phase 2: Apply offset ---
        let mut remaining_offset = args.offset;

        while remaining_offset > 0 && !path.is_empty() {
            let (_current_leaf_hash, current_leaf_node_obj_ref, _parent_idx) = path.last().unwrap(); // Should be a leaf
            
            // Clone to satisfy borrow checker if advance_..._leaf_static needs mutable self.path inside match
            let current_leaf_node_obj_clone = current_leaf_node_obj_ref.clone(); 

            if let Node::Leaf { entries, .. } = current_leaf_node_obj_clone {
                if !args.reverse { // Forward
                    let entries_in_current_leaf = entries.len();
                    // If current_leaf_entry_idx is already at/past the end, we must advance leaf first
                    if current_leaf_entry_idx >= entries_in_current_leaf {
                        if !Self::advance_cursor_path_to_next_leaf_static(&mut path, &store).await? {
                            remaining_offset = 0; // No more leaves, consumed all possible offset
                            current_leaf_entry_idx = entries_in_current_leaf; // Stay at end
                            break;
                        }
                        current_leaf_entry_idx = 0; // Start of new leaf
                        continue; // Re-evaluate with new leaf
                    }

                    let remaining_in_leaf = entries_in_current_leaf.saturating_sub(current_leaf_entry_idx);

                    if remaining_offset < remaining_in_leaf as u64 {
                        current_leaf_entry_idx += remaining_offset as usize;
                        remaining_offset = 0;
                    } else {
                        remaining_offset -= remaining_in_leaf as u64;
                        // Move to end of current leaf, then advance
                        current_leaf_entry_idx = entries_in_current_leaf; 
                        if !Self::advance_cursor_path_to_next_leaf_static(&mut path, &store).await? {
                            remaining_offset = 0; // No more leaves
                            break;
                        }
                        current_leaf_entry_idx = 0; // Start of new leaf
                    }
                } else { // Reverse
                    // If current_leaf_entry_idx is usize::MAX (before start), advance leaf first
                    if current_leaf_entry_idx == usize::MAX {
                        if !Self::advance_cursor_path_to_prev_leaf_static(&mut path, &store).await? {
                            remaining_offset = 0; // No more leaves
                            break;
                        }
                        // Set to last entry of new leaf
                        if let Some((_, new_leaf_ref, _)) = path.last() {
                           if let Node::Leaf{entries: new_entries, ..} = new_leaf_ref { // Borrow new_leaf_ref
                               current_leaf_entry_idx = new_entries.len().saturating_sub(1);
                               if new_entries.is_empty() { current_leaf_entry_idx = usize::MAX; }
                           } else { break; } // Should be a leaf
                        } else { break; } // Path became empty
                        continue; // Re-evaluate with new leaf
                    }
                    
                    let available_to_move_back_in_leaf = current_leaf_entry_idx + 1;

                    if remaining_offset < available_to_move_back_in_leaf as u64 {
                        current_leaf_entry_idx -= remaining_offset as usize;
                        remaining_offset = 0;
                    } else {
                        remaining_offset -= available_to_move_back_in_leaf as u64;
                        // Move to before start of current leaf, then advance
                        current_leaf_entry_idx = usize::MAX; 
                        if !Self::advance_cursor_path_to_prev_leaf_static(&mut path, &store).await? {
                            remaining_offset = 0; // No more leaves
                            break;
                        }
                        // Set to last entry of new leaf
                        if let Some((_, new_leaf_ref, _)) = path.last() {
                           if let Node::Leaf{entries: new_entries, ..} = new_leaf_ref { // Borrow new_leaf_ref
                               current_leaf_entry_idx = new_entries.len().saturating_sub(1);
                               if new_entries.is_empty() { current_leaf_entry_idx = usize::MAX; }
                           } else { break; }
                        } else { break; }
                    }
                }
            } else {
                break;
            }
        }
        // If remaining_offset > 0 here, it means offset exceeded available items.
        // current_leaf_entry_idx should be at end (forward) or usize::MAX (reverse).
        if remaining_offset > 0 && !path.is_empty() {
            if !args.reverse {
                if let Some((_, leaf_node_ref, _)) = path.last() {
                    if let Node::Leaf{entries, ..} = leaf_node_ref {
                        current_leaf_entry_idx = entries.len(); // Past the end
                    }
                }
            } else {
                current_leaf_entry_idx = usize::MAX; // Before the beginning
            }
        }


        // --- Phase 3: Final inclusivity adjustment (relative to bounds) ---
        if path.last().is_some() {
            let (_leaf_hash, leaf_node, _parent_idx) = path.last().unwrap();
            if let Node::Leaf { entries, .. } = leaf_node {
                if !args.reverse {
                    if let Some(sb_val) = &args.start_bound {
                        if current_leaf_entry_idx < entries.len() &&
                           !args.start_inclusive &&
                           entries[current_leaf_entry_idx].key == *sb_val {
                            current_leaf_entry_idx = current_leaf_entry_idx.saturating_add(1);
                        }
                    }
                } else { // Reverse scan
                    if let Some(sb_val) = &args.start_bound { // start_bound is upper limit
                        if current_leaf_entry_idx != usize::MAX && current_leaf_entry_idx < entries.len() &&
                           !args.start_inclusive && 
                           entries[current_leaf_entry_idx].key == *sb_val {
                            if current_leaf_entry_idx == 0 { current_leaf_entry_idx = usize::MAX; }
                            else { current_leaf_entry_idx = current_leaf_entry_idx.saturating_sub(1); }
                        }
                    }
                    // No adjustment for end_bound (lower limit) here for reverse;
                    // next_in_scan handles stopping at end_bound.
                }
            }
        }

        Ok(Self { store, config, path, current_leaf_entry_idx })
    }

    pub async fn next_in_scan(&mut self, args: &ScanArgs) -> Result<Option<(Key, Value)>> {

        loop {
            let current_path_len = self.path.len();
            if current_path_len == 0 {
                return Ok(None);
            }

            // Get current leaf node from the path stack
            // We clone here to avoid borrowing issues if we need to modify self.path later (e.g., in advance_to_next/prev_leaf)
            let (_leaf_hash, current_leaf_node_cloned, _idx_in_parent) = self.path.last().unwrap().clone();

            if let Node::Leaf { ref entries, .. } = current_leaf_node_cloned { // Use 'ref entries'

                let entry_opt: Option<&LeafEntry> = if !args.reverse {
                    if self.current_leaf_entry_idx >= entries.len() {
                        None
                    } else {
                        entries.get(self.current_leaf_entry_idx)
                    }
                } else { // Reverse
                    if self.current_leaf_entry_idx == usize::MAX || self.current_leaf_entry_idx >= entries.len() {
                        None
                    } else {
                        entries.get(self.current_leaf_entry_idx)
                    }
                };

                if let Some(entry) = entry_opt {
                    let key_ref = &entry.key;

                    // Boundary checks
                    if !args.reverse {
                        if let Some(ref eb) = args.end_bound {
                            match key_ref.cmp(eb) {
                                Ordering::Greater => {
                                    return Ok(None);
                                }
                                Ordering::Equal if !args.end_inclusive => {
                                    return Ok(None);
                                }
                                _ => {}
                            }
                        }
                    } else { // Reverse
                        if let Some(ref sb) = args.start_bound { // start_bound is the "upper" bound in reverse
                            match key_ref.cmp(sb) {
                                Ordering::Greater => {
                                    return Ok(None);
                                }
                                Ordering::Equal if !args.start_inclusive => {
                                    return Ok(None);
                                }
                                _ => { /* Key is <= start_bound or (== and inclusive). OK. */ }
                            }
                        }
                        if let Some(ref eb) = args.end_bound { // end_bound is the "lower" bound in reverse
                            match key_ref.cmp(eb) {
                                Ordering::Less => {
                                    return Ok(None);
                                }
                                Ordering::Equal if !args.end_inclusive => {
                                    return Ok(None);
                                }
                                _ => { /* Key is >= end_bound or (== and inclusive). OK. */ }
                            }
                        }
                    }

                    let value = self.load_value_repr_from_store(&entry.value).await?;

                    if !args.reverse {
                        self.current_leaf_entry_idx += 1;
                    } else {
                        if self.current_leaf_entry_idx == 0 {
                            self.current_leaf_entry_idx = usize::MAX; // Mark as before beginning of this leaf
                        } else {
                            self.current_leaf_entry_idx -= 1;
                        }
                    }
                    return Ok(Some((entry.key.clone(), value)));

                } else { // entry_opt was None
                    let advanced: bool = if !args.reverse {
                        // Need to pass self.path mutably
                        Self::advance_cursor_path_to_next_leaf_static(&mut self.path, &self.store).await?
                    } else {
                        Self::advance_cursor_path_to_prev_leaf_static(&mut self.path, &self.store).await?
                    };
                    
                    if !advanced {
                        return Ok(None);
                    }

                    // After advancing, set index to start/end of new leaf
                    if let Some((_, new_leaf_node, _)) = self.path.last() {
                        if let Node::Leaf{entries: new_entries, ..} = new_leaf_node {
                            self.current_leaf_entry_idx = if !args.reverse { 0 }
                                                        else { new_entries.len().saturating_sub(1) };
                            if args.reverse && new_entries.is_empty() { self.current_leaf_entry_idx = usize::MAX; }
                        } else {
                            return Err(ProllyError::InternalError("Advanced cursor path did not end in a leaf".to_string()));
                        }
                    } else { // Path became empty after advance, should have been caught by !advanced
                        return Ok(None);
                    }
                    // Loop again to process the new leaf/index
                }
            } else {
                return Err(ProllyError::InternalError("Cursor path top was not a LeafNode during next_in_scan".to_string()));
            }
        } // loop will continue
    }

    // Make sure advance_to_next_leaf and advance_to_prev_leaf are pub(crate) or pub if needed by ProllyTree directly
    pub(crate) async fn advance_to_next_leaf(&mut self) -> Result<bool> { // Changed to pub(crate)
        let advanced = Self::advance_cursor_path_to_next_leaf_static(&mut self.path, &self.store).await?;
        if advanced {
            self.current_leaf_entry_idx = 0; 
        }
        Ok(advanced)
    }

    // Add advance_to_prev_leaf if it's not there or make it pub(crate)
    #[allow(dead_code)] // If not used elsewhere yet
    pub(crate) async fn advance_to_prev_leaf(&mut self) -> Result<bool> { // Changed to pub(crate)
        let advanced = Self::advance_cursor_path_to_prev_leaf_static(&mut self.path, &self.store).await?;
        if advanced {
            // When moving to a previous leaf, set index to its last entry
            if let Some((_, new_leaf_node, _)) = self.path.last() {
                if let Node::Leaf { entries, .. } = new_leaf_node {
                    self.current_leaf_entry_idx = entries.len().saturating_sub(1);
                    if entries.is_empty() { self.current_leaf_entry_idx = usize::MAX; }
                } else {
                    // Should not happen if path logic is correct
                    return Err(ProllyError::InternalError("Advanced to previous non-leaf node".to_string()));
                }
            } else {
                // Path became empty, should not happen if advanced is true
                return Err(ProllyError::InternalError("Path empty after advancing to previous leaf".to_string()));
            }
        }
        Ok(advanced)
    }

}