// packages/prolly-rust/src/gc.rs

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use log::trace; // Optional: for logging GC progress

use crate::common::Hash;
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr};
use crate::store::ChunkStore;

pub struct GarbageCollector<S: ChunkStore> {
    store: Arc<S>,
    // No TreeConfig needed here if Node::decode and ValueRepr are self-contained
    // and don't require external config for interpretation during GC.
}

impl<S: ChunkStore> GarbageCollector<S> {
    pub fn new(store: Arc<S>) -> Self {
        Self { store }
    }

    /// Performs a mark-and-sweep garbage collection.
    ///
    /// # Arguments
    /// * `live_root_hashes`: A slice of `Hash` representing all currently active
    ///   root nodes. All chunks reachable from these roots will be preserved.
    ///
    /// # Returns
    /// `Ok(usize)` with the number of chunks collected (deleted), or an error.
    pub async fn collect(&self, live_root_hashes: &[Hash]) -> Result<usize> {
        trace!("Starting garbage collection. Live roots: {:?}", live_root_hashes);

        let all_store_hashes = self.store.all_hashes().await?;
        if all_store_hashes.is_empty() {
            trace!("GC: Store is empty, nothing to collect.");
            return Ok(0);
        }
        let all_store_hashes_set: HashSet<Hash> = all_store_hashes.into_iter().collect();
        trace!("GC: Found {} total chunks in store before GC.", all_store_hashes_set.len());


        let mut live_chunks_set = HashSet::new();
        let mut queue = VecDeque::new();

        // Initialize queue with live root hashes that are actually in the store
        for root_hash in live_root_hashes {
            if all_store_hashes_set.contains(root_hash) {
                queue.push_back(*root_hash);
            } else {
                // This root_hash is not in the store, so it can't be a starting point for live chunks.
                // It might be a hash of an empty tree (None) or an old, already GC'd root.
                trace!("GC: Live root hash {:?} not found in store, skipping for marking.", root_hash);
            }
        }
        
        if queue.is_empty() && !live_root_hashes.is_empty() && live_root_hashes.iter().any(|h| all_store_hashes_set.contains(h) ) {
            // This case should not happen if live_root_hashes contains valid, existing roots.
            // If queue is empty but there were valid live roots, it's an issue.
            // However, if all live_root_hashes were not in the store, queue would be empty, and that's fine (everything collected).
        }


        trace!("GC: Initializing mark phase with {} valid root(s) in queue.", queue.len());

        // Mark phase
        while let Some(hash_to_process) = queue.pop_front() {
            if live_chunks_set.contains(&hash_to_process) {
                continue; // Already processed
            }

            // Check if the hash to process actually exists in the store before attempting to get it.
            // This check is somewhat redundant due to `all_store_hashes_set` usage but good for safety.
            if !all_store_hashes_set.contains(&hash_to_process) {
                trace!("GC: Hash {:?} from queue not found in store hashes set. Skipping.", hash_to_process);
                continue;
            }

            live_chunks_set.insert(hash_to_process);
            trace!("GC: Marked chunk {:?} as live.", hash_to_process);

            match self.store.get(&hash_to_process).await {
                Ok(Some(bytes)) => {
                    // Attempt to decode as a Node to find further references
                    if let Ok(node) = Node::decode(&bytes) {
                        match node {
                            Node::Leaf { entries, .. } => {
                                for entry in entries {
                                    match &entry.value {
                                        ValueRepr::Chunked(data_hash) => {
                                            if all_store_hashes_set.contains(data_hash) && !live_chunks_set.contains(data_hash) {
                                                queue.push_back(*data_hash);
                                            }
                                        }
                                        ValueRepr::ChunkedSequence { chunk_hashes, .. } => {
                                            for data_hash in chunk_hashes {
                                                if all_store_hashes_set.contains(data_hash) && !live_chunks_set.contains(data_hash) {
                                                    queue.push_back(*data_hash);
                                                }
                                            }
                                        }
                                        ValueRepr::Inline(_) => {}
                                    }
                                }
                            }
                            Node::Internal { children, .. } => {
                                for child_entry in children {
                                    if all_store_hashes_set.contains(&child_entry.child_hash) && !live_chunks_set.contains(&child_entry.child_hash) {
                                        queue.push_back(child_entry.child_hash);
                                    }
                                }
                            }
                        }
                    } else {
                        // If decode fails, it's a data chunk. It's already marked live.
                        // No further references to follow from a raw data chunk.
                        trace!("GC: Chunk {:?} is a data chunk (or failed to decode as node).", hash_to_process);
                    }
                }
                Ok(None) => {
                    // This should ideally not happen if `all_store_hashes_set` is accurate and
                    // chunks aren't deleted concurrently during GC.
                    return Err(ProllyError::InternalError(format!(
                        "GC: Chunk {:?} was expected in store but not found during get.",
                        hash_to_process
                    )));
                }
                Err(e) => {
                    // Handle error from store.get if necessary
                    return Err(ProllyError::StorageError(format!(
                        "GC: Error getting chunk {:?} from store: {}",
                        hash_to_process, e
                    )));
                }
            }
        }
        trace!("GC: Mark phase complete. {} chunks marked as live.", live_chunks_set.len());

        // Sweep phase
        let mut dead_chunks_vec = Vec::new();
        for store_hash in all_store_hashes_set { // Iterate over original set of all hashes
            if !live_chunks_set.contains(&store_hash) {
                dead_chunks_vec.push(store_hash);
            }
        }

        let collected_count = dead_chunks_vec.len();
        if !dead_chunks_vec.is_empty() {
            trace!("GC: Sweeping {} dead chunks.", collected_count);
            self.store.delete_batch(&dead_chunks_vec).await?;
        } else {
            trace!("GC: No dead chunks to sweep.");
        }

        Ok(collected_count)
    }
}