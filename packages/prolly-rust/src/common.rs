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

    /// Minimum chunk size for CDC.
    pub cdc_min_size: usize,
    /// Average chunk size target for CDC.
    pub cdc_avg_size: usize,
    /// Maximum chunk size for CDC.
    pub cdc_max_size: usize,
    /// Values larger than this will be chunked using CDC. Smaller values are inlined.
    pub max_inline_value_size: usize,
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
            // Default CDC parameters (adjust as needed for typical data)
            // Using values often seen in examples, target ~16KiB average.
            cdc_min_size: 4 * 1024,     // 4 KiB
            cdc_avg_size: 16 * 1024,    // 16 KiB
            cdc_max_size: 64 * 1024,    // 64 KiB
            // Default threshold for inlining (e.g., don't chunk small values)
            // Might set this lower than cdc_min_size, or equal to avg, depends on strategy.
            // Let's start relatively low. Consider average cost of storing hash vs inline data.
            max_inline_value_size: 1024, // 1 KiB threshold for chunking
        }
    }
}