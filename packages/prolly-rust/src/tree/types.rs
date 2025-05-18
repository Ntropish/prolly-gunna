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