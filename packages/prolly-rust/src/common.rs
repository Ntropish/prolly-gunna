// prolly-rust/src/common.rs

use serde::{Serialize, Deserialize};

/// A 32-byte hash, typically from Blake3.
pub type Hash = [u8; 32];

/// Type alias for keys used in the Prolly Tree.
pub type Key = Vec<u8>;

/// Type alias for values stored in the Prolly Tree.
pub type Value = Vec<u8>;

/// Configuration for the Prolly Tree.
/// We'll add more to this as we develop (e.g., fanout, CDC params).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeConfig {
    /// The desired number of entries in a leaf node or children in an internal node.
    /// This influences when nodes split or merge.
    pub target_fanout: usize,
    /// Minimum number of entries/children a node can have before attempting to merge
    /// or rebalance (typically fanout / 2).
    pub min_fanout: usize,
    // Future: Add CDC parameters like min_chunk_size, avg_chunk_size, max_chunk_size
    // Future: Add max_inline_value_size before chunking a value separately
}

impl Default for TreeConfig {
    fn default() -> Self {
        // Default fanout values, can be tuned.
        // Noms uses a target block size (e.g. 4KB) and lets fanout vary.
        // For a fixed fanout approach, these are direct settings.
        // Let's start with something moderate.
        let target_fanout = 32; // Corresponds to the existing FANOUT in node.rs
        TreeConfig {
            target_fanout,
            min_fanout: target_fanout / 2,
        }
    }
}