use crate::common::{Hash, Key, Value};
use serde::{Deserialize, Serialize};

// --- Internal Helper Structs/Enums ---

#[derive(Debug)]
pub(super) struct ProcessedNodeUpdate {
    pub(super) new_hash: Hash,
    pub(super) new_boundary_key: Key,
    pub(super) new_item_count: u64,
    pub(super) split_info: Option<(Key, Hash, u64)>, // (boundary_key_of_new_sibling, new_sibling_hash, new_sibling_item_count)
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

// --- Public API Data Structs ---

// Helper functions for Serde default values for ScanArgs.
fn default_start_inclusive() -> bool {
    true
}
fn default_end_inclusive() -> bool {
    false
}
fn default_reverse() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_bound: Option<Key>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_bound: Option<Key>,
    #[serde(default = "default_start_inclusive")]
    pub start_inclusive: bool,
    #[serde(default = "default_end_inclusive")]
    pub end_inclusive: bool,
    #[serde(default = "default_reverse")]
    pub reverse: bool,
    #[serde(default)]
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

impl Default for ScanArgs {
    fn default() -> Self {
        ScanArgs {
            start_bound: None,
            end_bound: None,
            start_inclusive: default_start_inclusive(),
            end_inclusive: default_end_inclusive(),
            reverse: default_reverse(),
            offset: 0,
            limit: None,
        }
    }
}

#[derive(Debug, Serialize)]
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