// Prolly Tree Diffing Module
//
//! Computes differences between two versions of a Prolly Tree.

use async_recursion::async_recursion;
use futures::future::try_join_all; 
use log::{debug, trace, warn, error};
use std::collections::VecDeque; // Could be useful for iteration helpers
use std::sync::Arc;

use crate::common::{Hash, Key, Value, TreeConfig}; // Need config potentially for value loading?
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr};
use crate::store::ChunkStore;

/// Represents a single difference between two tree versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffEntry {
    pub key: Key,
    /// Value in the 'left' (or 'from') tree. None if added.
    pub left_value: Option<Value>,
    /// Value in the 'right' (or 'to') tree. None if deleted.
    pub right_value: Option<Value>,
}

impl DiffEntry {
    fn addition(key: Key, right_value: Value) -> Self {
        Self { key, left_value: None, right_value: Some(right_value) }
    }
    fn deletion(key: Key, left_value: Value) -> Self {
        Self { key, left_value: Some(left_value), right_value: None }
    }
    fn modification(key: Key, left_value: Value, right_value: Value) -> Self {
        Self { key, left_value: Some(left_value), right_value: Some(right_value) }
    }
}

/// Computes the differences between two Prolly Trees represented by their root hashes.
/// 
/// Requires shared access to a `ChunkStore` that contains the nodes for *both* trees.
pub async fn diff_trees<S: ChunkStore>(
    left_root_hash: Option<Hash>,
    right_root_hash: Option<Hash>,
    store: Arc<S>, // Use Arc for shared ownership across async calls
    config: TreeConfig, // Pass config for value reconstruction if needed
) -> Result<Vec<DiffEntry>> {
    recursive_diff(left_root_hash, right_root_hash, store, config).await
}

#[async_recursion] // Use macro to handle async recursion boxing
async fn recursive_diff<S: ChunkStore>(
    left_hash: Option<Hash>,
    right_hash: Option<Hash>,
    store: Arc<S>,
    config: TreeConfig, // Cloned or passed down
) -> Result<Vec<DiffEntry>> {
    
    trace!("recursive_diff called with left={:?}, right={:?}", left_hash, right_hash);

    // --- Base Cases ---
    if left_hash == right_hash {
        // Hashes match (or both are None), subtrees are identical.
        return Ok(Vec::new());
    }

    if left_hash.is_none() {
        // Left side doesn't exist, everything on right is an addition.
        debug!("Diff: Left side None, generating additions for right hash {:?}", right_hash);
        return generate_diffs_for_subtree(right_hash.unwrap(), &store, &config, true).await;
    }

    if right_hash.is_none() {
        // Right side doesn't exist, everything on left is a deletion.
        debug!("Diff: Right side None, generating deletions for left hash {:?}", left_hash);
        return generate_diffs_for_subtree(left_hash.unwrap(), &store, &config, false).await;
    }

    // --- Recursive Step: Hashes differ and both exist ---
    let h1 = left_hash.unwrap();
    let h2 = right_hash.unwrap();

    // Load both nodes
    // TODO: Optimize - load nodes concurrently? e.g., using try_join!
    let node1 = load_node_for_diff(&h1, &store).await?;
    let node2 = load_node_for_diff(&h2, &store).await?;

    let mut diffs = Vec::new();

    match (node1, node2) {
        // --- Case 1: Both are Leaf Nodes ---
        (Node::Leaf { entries: entries1, .. }, Node::Leaf { entries: entries2, .. }) => {
            debug!("Diff: Comparing leaves {:?} and {:?}", h1, h2);
            // Perform a sorted merge diff on the leaf entries
            let mut iter1 = entries1.into_iter().peekable();
            let mut iter2 = entries2.into_iter().peekable();

            loop {
                match (iter1.peek(), iter2.peek()) {
                    (Some(e1), Some(e2)) => {
                        use std::cmp::Ordering::*;
                        match e1.key.cmp(&e2.key) {
                            Less => { // e1.key is smaller, means e1 was deleted
                                let deleted_entry = iter1.next().unwrap();
                                let val = load_value_repr(&deleted_entry.value, &store, &config).await?;
                                diffs.push(DiffEntry::deletion(deleted_entry.key, val));
                            }
                            Greater => { // e2.key is smaller, means e2 was added
                                let added_entry = iter2.next().unwrap();
                                let val = load_value_repr(&added_entry.value, &store, &config).await?;
                                diffs.push(DiffEntry::addition(added_entry.key, val));
                            }
                            Equal => { // Keys match, check values
                                let entry1 = iter1.next().unwrap();
                                let entry2 = iter2.next().unwrap();
                                let val1 = load_value_repr(&entry1.value, &store, &config).await?;
                                let val2 = load_value_repr(&entry2.value, &store, &config).await?;
                                if val1 != val2 { // Values differ, modification
                                    diffs.push(DiffEntry::modification(entry1.key, val1, val2));
                                }
                                // If values are equal, no diff entry needed.
                            }
                        }
                    }
                    (Some(_), None) => { // Remaining entries in iter1 are deletions
                        let deleted_entry = iter1.next().unwrap();
                        let val = load_value_repr(&deleted_entry.value, &store, &config).await?;
                        diffs.push(DiffEntry::deletion(deleted_entry.key, val));
                    }
                    (None, Some(_)) => { // Remaining entries in iter2 are additions
                        let added_entry = iter2.next().unwrap();
                        let val = load_value_repr(&added_entry.value, &store, &config).await?;
                        diffs.push(DiffEntry::addition(added_entry.key, val));
                    }
                    (None, None) => break, // Both iterators exhausted
                }
            }
        }

        // --- Case 2: Both are Internal Nodes ---
        (Node::Internal { children: children1, level: l1 }, Node::Internal { children: children2, level: l2 }) => {
             debug!("Diff: Comparing internal nodes {:?} and {:?}", h1, h2);
             if l1 != l2 {
                 // Levels mismatch - treat as full add/delete for simplicity
                 // A more complex diff could try to correlate subtrees despite level change.
                 warn!("Diff: Internal nodes {:?} and {:?} have different levels ({} vs {}), treating as full add/delete.", h1, h2, l1, l2);
                 diffs.extend(generate_diffs_for_subtree(h1, &store, &config, false).await?); // false = deletions
                 diffs.extend(generate_diffs_for_subtree(h2, &store, &config, true).await?); // true = additions
                 return Ok(diffs);
             }
            
            // Perform sorted merge diff on children entries based on boundary_key
            let mut iter1 = children1.into_iter().peekable();
            let mut iter2 = children2.into_iter().peekable();
            let mut child_diff_futures = Vec::new(); // Collect futures for concurrent execution

            loop {
                 match (iter1.peek(), iter2.peek()) {
                    (Some(c1), Some(c2)) => {
                        use std::cmp::Ordering::*;
                        match c1.boundary_key.cmp(&c2.boundary_key) {
                             Less => { // c1 range ends first, unique to left side (deletion)
                                 let entry1 = iter1.next().unwrap();
                                 child_diff_futures.push(
                                     recursive_diff(Some(entry1.child_hash), None, Arc::clone(&store), config.clone())
                                 );
                             }
                             Greater => { // c2 range ends first, unique to right side (addition)
                                 let entry2 = iter2.next().unwrap();
                                 child_diff_futures.push(
                                      recursive_diff(None, Some(entry2.child_hash), Arc::clone(&store), config.clone())
                                 );
                             }
                             Equal => { // Boundary keys match, compare child hashes
                                 let entry1 = iter1.next().unwrap();
                                 let entry2 = iter2.next().unwrap();
                                 // Only recurse if child hashes differ
                                 if entry1.child_hash != entry2.child_hash {
                                      child_diff_futures.push(
                                          recursive_diff(Some(entry1.child_hash), Some(entry2.child_hash), Arc::clone(&store), config.clone())
                                      );
                                 }
                                 // If child hashes match, the subtrees are identical, do nothing.
                             }
                        }
                    }
                    (Some(_), None) => { // Remaining children in iter1 are deletions
                         let entry1 = iter1.next().unwrap();
                         child_diff_futures.push(
                             recursive_diff(Some(entry1.child_hash), None, Arc::clone(&store), config.clone())
                         );
                    }
                    (None, Some(_)) => { // Remaining children in iter2 are additions
                         let entry2 = iter2.next().unwrap();
                         child_diff_futures.push(
                              recursive_diff(None, Some(entry2.child_hash), Arc::clone(&store), config.clone())
                         );
                    }
                    (None, None) => break, // Both iterators exhausted
                 }
            }
            
            // Execute all recursive calls concurrently and collect results
             let results: Vec<Vec<DiffEntry>> = try_join_all(child_diff_futures).await?;
             for result_vec in results {
                 diffs.extend(result_vec);
             }
        }

        // --- Case 3: One Leaf, One Internal ---
        // Indicates significant structural change. Treat as delete left, add right.
        (Node::Leaf { .. }, Node::Internal { .. }) | (Node::Internal { .. }, Node::Leaf { .. }) => {
            warn!("Diff: Node types mismatch ({:?} vs {:?}), treating as full add/delete.", h1, h2);
            // Run concurrently?
             let (deletions, additions) = tokio::try_join!(
                 generate_diffs_for_subtree(h1, &store, &config, false), // false = deletions
                 generate_diffs_for_subtree(h2, &store, &config, true) // true = additions
             )?;
             diffs.extend(deletions);
             diffs.extend(additions);
        }
    }

    Ok(diffs)
}


/// Helper function to load a node required for diffing.
async fn load_node_for_diff<S: ChunkStore>(hash: &Hash, store: &Arc<S>) -> Result<Node> {
    let bytes = store.get(hash).await?
        .ok_or_else(|| {
            error!("Diff failed: Chunk not found for hash {:?}", hash); // Log error if chunk is missing
            ProllyError::ChunkNotFound(*hash)
        })?;
    Node::decode(&bytes).map_err(|e| {
         error!("Diff failed: Failed to decode node for hash {:?}: {}", hash, e);
         e
    })
}


/// Helper function to reconstruct a Value from its ValueRepr, loading chunks if needed.
async fn load_value_repr<S: ChunkStore>(
    value_repr: &ValueRepr,
    store: &Arc<S>,
    _config: &TreeConfig, // Config might be needed later if value limits apply
) -> Result<Value> {
    match value_repr {
        ValueRepr::Inline(val) => Ok(val.clone()),
        ValueRepr::Chunked(data_hash) => {
            store.get(data_hash).await?
                .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))
        }
        ValueRepr::ChunkedSequence { chunk_hashes, total_size } => {
            let mut reconstructed_value = Vec::with_capacity(*total_size as usize);
            for chunk_hash in chunk_hashes {
                let chunk_bytes = store.get(chunk_hash).await?
                    .ok_or_else(|| ProllyError::ChunkNotFound(*chunk_hash))?;
                reconstructed_value.extend_from_slice(&chunk_bytes);
            }
            if reconstructed_value.len() as u64 != *total_size {
                 warn!("Diff/LoadValue: Reconstructed value size mismatch. Expected {}, got {}.", total_size, reconstructed_value.len());
                 // Return potentially corrupt data or error? For now, return what we have.
            }
            Ok(reconstructed_value)
        }
    }
}


/// Helper function to generate Add or Delete diff entries for an entire subtree.
/// `is_addition`: true generates Additions, false generates Deletions.
async fn generate_diffs_for_subtree<S: ChunkStore>(
    root_hash: Hash,
    store: &Arc<S>,
    config: &TreeConfig,
    is_addition: bool,
) -> Result<Vec<DiffEntry>> {
    let mut diffs = Vec::new();
    let mut queue: VecDeque<Hash> = VecDeque::new(); // Use VecDeque for BFS traversal
    queue.push_back(root_hash);

    while let Some(hash) = queue.pop_front() {
        let node = load_node_for_diff(&hash, store).await?;
        match node {
            Node::Leaf { entries, .. } => {
                for entry in entries {
                    // Must load value potentially from chunks
                    let value = load_value_repr(&entry.value, store, config).await?; 
                    if is_addition {
                        diffs.push(DiffEntry::addition(entry.key, value));
                    } else {
                        diffs.push(DiffEntry::deletion(entry.key, value));
                    }
                }
            }
            Node::Internal { children, .. } => {
                for child_entry in children {
                    queue.push_back(child_entry.child_hash);
                }
            }
        }
    }
    Ok(diffs)
}