//! Placeholder diff algorithm – coming soon.
use crate::store::ChunkStore;

pub struct Change { pub key: Vec<u8>, pub left: Option<Vec<u8>>, pub right: Option<Vec<u8>>, }

pub fn diff_trees<S: ChunkStore>(_l: &[u8; 32], _r: &[u8; 32], _store: &S) -> Vec<Change> {
    Vec::new()
}