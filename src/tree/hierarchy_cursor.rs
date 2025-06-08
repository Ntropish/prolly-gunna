// In packages/prolly-rust/src/tree/hierarchy_cursor.rs

use std::pin::Pin;
use std::future::Future;
use std::sync::Arc;
use std::collections::VecDeque;

use crate::platform::{PlatformStore};
use crate::common::{Hash, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr};
use crate::store::ChunkStore;
use crate::tree::{ProllyTree, types::{HierarchyScanArgs, HierarchyItem}};

#[derive(Debug)]
pub struct HierarchyCursor<S: ChunkStore> {
    store: Arc<S>,
    #[allow(dead_code)]
    config: TreeConfig,
    args: HierarchyScanArgs, // For max_depth, start_key etc.

    traversal_queue: VecDeque<(Hash, usize, Vec<usize>)>,
    current_node_entries_queue: VecDeque<(Hash, Node, usize, usize)>,
    // REMOVED: page_limit and items_yielded_count
}

impl<S: PlatformStore> HierarchyCursor<S>  {
    pub(crate) async fn new_for_hierarchy_scan(
        tree: &ProllyTree<S>,
        args: HierarchyScanArgs,
    ) -> Result<Self> {
        let mut traversal_queue = VecDeque::new();
        if let Some(root_hash) = tree.root_hash {
            traversal_queue.push_back((root_hash, 0, vec![]));
        }

        Ok(Self {
            store: Arc::clone(&tree.store),
            config: tree.config.clone(),
            args: args.clone(), // args now primarily for max_depth, start_key
            traversal_queue,
            current_node_entries_queue: VecDeque::new(),
        })
    }

    async fn load_node(&self, hash: &Hash) -> Result<Node> {
        let bytes = self.store.get(hash).await?
            .ok_or_else(|| ProllyError::ChunkNotFound(*hash))?;
        Node::decode(&bytes)
    }

    pub fn next_item<'s>(&'s mut self) -> Pin<Box<dyn Future<Output = Result<Option<HierarchyItem>>> + Send + 's>>
    where
        S: 's, 
    {
        Box::pin(async move {

            if let Some(&mut (ref mut parent_hash_val, ref node_ref, ref mut entry_idx_ref, ref mut _entry_type_ref)) = self.current_node_entries_queue.front_mut() {
                let current_parent_hash = *parent_hash_val;
                let item_to_yield = match *node_ref {
                    Node::Internal { ref children, .. } => {
                        if *entry_idx_ref < children.len() {
                            let internal_entry = &children[*entry_idx_ref];
                            let item = HierarchyItem::InternalEntryItem {
                                parent_hash: current_parent_hash,
                                entry_index: *entry_idx_ref,
                                boundary_key: internal_entry.boundary_key.clone(),
                                child_hash: internal_entry.child_hash,
                                num_items_subtree: internal_entry.num_items_subtree,
                            };
                            *entry_idx_ref += 1;
                            Some(item)
                        } else { None }
                    }
                    Node::Leaf { ref entries, .. } => {
                        if *entry_idx_ref < entries.len() {
                            let leaf_entry = &entries[*entry_idx_ref];
                            let value_repr_borrow = &leaf_entry.value;
                            let (value_repr_type, value_hash, value_size) = match value_repr_borrow {
                                ValueRepr::Inline(v) => ("Inline".to_string(), None, v.len() as u64),
                                ValueRepr::Chunked(h) => {
                                    let chunk_data = self.store.get(h).await?;
                                    ("Chunked".to_string(), Some(*h), chunk_data.map_or(0, |d| d.len() as u64))
                                },
                                ValueRepr::ChunkedSequence{ chunk_hashes, total_size} => ("ChunkedSequence".to_string(), chunk_hashes.first().copied(), *total_size),
                            };
                            let item = HierarchyItem::LeafEntryItem {
                                parent_hash: current_parent_hash,
                                entry_index: *entry_idx_ref,
                                key: leaf_entry.key.clone(),
                                value_repr_type, value_hash, value_size,
                            };
                            *entry_idx_ref += 1;
                            Some(item)
                        } else { None }
                    }
                };
                if item_to_yield.is_some() {
                    return Ok(item_to_yield); // REMOVED items_yielded_count increment
                } else {
                    self.current_node_entries_queue.pop_front();
                }
            }

            if let Some((node_hash, depth, path_indices)) = self.traversal_queue.pop_front() {
                if self.args.max_depth.is_some() && depth > self.args.max_depth.unwrap() {
                    return self.next_item().await;
                }
                let loaded_node_for_processing = self.load_node(&node_hash).await?;
                let (is_leaf, num_entries, entry_type_code_val) = match &loaded_node_for_processing {
                    Node::Leaf { entries, .. } => (true, entries.len(), 1),
                    Node::Internal { children, .. } => (false, children.len(), 0),
                };
                let node_item = HierarchyItem::Node {
                    hash: node_hash,
                    level: loaded_node_for_processing.level(),
                    is_leaf, num_entries,
                    path_indices: path_indices.clone(),
                };
                if num_entries > 0 {
                    self.current_node_entries_queue.push_back((node_hash, loaded_node_for_processing.clone(), 0, entry_type_code_val));
                }
                if let Node::Internal { children, .. } = &loaded_node_for_processing {
                    if self.args.max_depth.is_none() || depth < self.args.max_depth.unwrap() {
                        for (i, child_entry) in children.iter().enumerate().rev() {
                            let mut child_path_indices = path_indices.clone();
                            child_path_indices.push(i);
                            self.traversal_queue.push_front((child_entry.child_hash, depth + 1, child_path_indices));
                        }
                    }
                }
                return Ok(Some(node_item)); // REMOVED items_yielded_count increment
            }
            Ok(None)
        })
    }
}