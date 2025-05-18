// prolly-rust/src/tree/types.rs
use crate::common::{Hash, Key, Value};
use serde::{Deserialize, Serialize};

// --- Internal Helper Structs/Enums ---
#[derive(Debug)]
pub(super) struct ProcessedNodeUpdate {
    pub(super) new_hash: Hash,
    pub(super) new_boundary_key: Key,
    pub(super) new_item_count: u64,
    pub(super) split_info: Option<(Key, Hash, u64)>,
}

#[derive(Debug)]
pub(super) enum DeleteRecursionResult {
    NotFound {
        node_hash: Hash,
        boundary_key: Key,
    },
    Updated(ProcessedNodeUpdate),
    Merged,
}

// --- Public API Data Structs (Internal Rust Representation) ---

// Helper functions for default values - Ensure all are public
pub fn default_start_inclusive() -> bool { true }
pub fn default_end_inclusive() -> bool { false }
pub fn default_reverse() -> bool { false }
pub fn default_offset() -> u64 { 0 } // Make sure this one is present and public

#[derive(Debug, Clone, Serialize, Deserialize)] // Ensure Deserialize is here
#[serde(rename_all = "camelCase")]
pub struct ScanArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")] // skip_serializing_if is for output, default is for input
    pub start_bound: Option<Key>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_bound: Option<Key>,
    #[serde(default = "default_start_inclusive")]
    pub start_inclusive: bool,
    #[serde(default = "default_end_inclusive")]
    pub end_inclusive: bool,
    #[serde(default = "default_reverse")]
    pub reverse: bool,
    #[serde(default = "default_offset")] // Or just #[serde(default)] if 0 is acceptable for u64 via std::default::Default
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

impl Default for ScanArgs {
    fn default() -> Self {
        Self {
            start_bound: None,
            end_bound: None,
            start_inclusive: default_start_inclusive(),
            end_inclusive: default_end_inclusive(),
            reverse: default_reverse(),
            offset: default_offset(),
            limit: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
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


/// Arguments for a hierarchy scan operation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyScanArgs {
    /// Optional key to start the scan from. The scan will attempt to find this key
    /// and begin yielding nodes on the path to it, and then nodes thereafter.
    /// If None, starts from the root of the tree.
    pub start_key: Option<Key>,

    /// Optional depth limit for the scan.
    /// 0 means only the root. 1 means root and its direct children, etc.
    /// None means no depth limit.
    pub max_depth: Option<usize>,

    /// Limit the number of hierarchy items returned in one page.
    pub limit: Option<usize>,

    pub offset: Option<usize>,
}

/// Represents an item encountered during a hierarchy scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HierarchyItem {
    Node {
        hash: Hash,
        level: u8,
        is_leaf: bool,
        num_entries: usize, // Number of entries in this node (children for internal, k/v for leaf)
        path_indices: Vec<usize>, // Index of this node in its parent, and so on up to root
    },
    InternalEntryItem {
        parent_hash: Hash,
        entry_index: usize,
        boundary_key: Key,
        child_hash: Hash,
        num_items_subtree: u64,
    },
    LeafEntryItem {
        parent_hash: Hash,
        entry_index: usize,
        key: Key,
        value_repr_type: String, // "Inline", "Chunked", "ChunkedSequence"
        value_hash: Option<Hash>, // Only for Chunked or first hash of ChunkedSequence
        value_size: u64, // Inline size or total_size for ChunkedSequence
    },
    // Could add NodeEnd if needed for certain iteration patterns.
}

/// A page of results from a hierarchy scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyScanPage {
    pub items: Vec<HierarchyItem>,
    /// Indicates if there are more items beyond this page.
    /// This might be simpler to determine by whether `items.len() == limit`.
    pub has_next_page: bool,
    /// Optional cursor to get the next page.
    /// This could be a serialized state of the HierarchyCursor or a specific reference point.
    /// For simplicity, we might initially not support a resumable cursor beyond the limit.
    pub next_page_cursor_token: Option<String>, // Placeholder for actual cursor mechanism
}