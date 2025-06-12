use std::pin::Pin;
use std::future::Future;
use log::warn;

use crate::common::{Hash, Key, Value};
use crate::node::definition::{Node, LeafEntry, InternalEntry, ValueRepr};
use crate::store::ChunkStore;
use crate::error::{Result, ProllyError};

use super::types::{ProcessedNodeUpdate, DeleteRecursionResult};
use super::prolly_tree::ProllyTree; // Used for type context and methods like load_node, config
use super::io;
use super::modification;

pub(super) fn get_recursive_sync_impl<S: ChunkStore>(
    tree: &ProllyTree<S>,
    node_hash: Hash,
    key: &Key,
) -> Result<Option<Value>> {
    let node = tree.load_node_sync(&node_hash)?;
    match node {
        Node::Leaf { entries, .. } => {
            match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                Ok(index) => {
                    let entry = &entries[index];
                    // The value loading logic is now encapsulated in the tree
                    tree.load_value_repr_sync(&entry.value)
                }
                Err(_) => Ok(None),
            }
        }
        Node::Internal { children, .. } => {
            if children.is_empty() {
                return Ok(None);
            }
            let mut child_idx_to_search = children.len() - 1;
            for (idx, child_entry) in children.iter().enumerate() {
                if key.as_slice() <= &child_entry.boundary_key {
                    child_idx_to_search = idx;
                    break;
                }
            }
            get_recursive_sync_impl(tree, children[child_idx_to_search].child_hash, key)
        }
    }
}

pub(super) fn get_recursive_impl<'s, S: ChunkStore + 's>(
    tree: &'s ProllyTree<S>,
    node_hash: Hash,
    key: Key,
) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 's>> {
    Box::pin(async move {
        let node = tree.load_node(&node_hash).await?;
        match node {
            Node::Leaf { entries, .. } => {
                match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                    Ok(index) => {
                        let entry = &entries[index];
                        match &entry.value {
                            ValueRepr::Inline(val) => Ok(Some(val.clone())),
                            ValueRepr::Chunked(data_hash) => {
                                let value_bytes = tree.store.get(data_hash).await?
                                    .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))?;
                                Ok(Some(value_bytes))
                            }
                            ValueRepr::ChunkedSequence { chunk_hashes, total_size } => {
                                let mut reconstructed_value = Vec::with_capacity(*total_size as usize);
                                for chunk_hash in chunk_hashes {
                                    let chunk_bytes = tree.store.get(chunk_hash).await?
                                        .ok_or_else(|| ProllyError::ChunkNotFound(*chunk_hash))?;
                                    reconstructed_value.extend_from_slice(&chunk_bytes);
                                }
                                if reconstructed_value.len() as u64 != *total_size {
                                    warn!("Reconstructed value size mismatch for key {:?}. Expected {}, got {}.", key, total_size, reconstructed_value.len());
                                }
                                Ok(Some(reconstructed_value))
                            }
                        }
                    }
                    Err(_) => Ok(None),
                }
            }
            Node::Internal { children, .. } => {
                if children.is_empty() {
                    return Ok(None);
                }
                let mut child_idx_to_search = children.len() - 1;
                for (idx, child_entry) in children.iter().enumerate() {
                    if key.as_slice() <= &child_entry.boundary_key {
                        child_idx_to_search = idx;
                        break;
                    }
                }
                // Recursive call through the tree's main method to ensure correct lifetime pinning if necessary,
                // or directly if signature matches. Here, direct call is fine.
                get_recursive_impl(tree, children[child_idx_to_search].child_hash, key).await
            }
        }
    })
}

pub(super) fn insert_recursive_impl<'s, S: ChunkStore + 's>(
    tree: &'s ProllyTree<S>,
    current_node_hash: Hash,
    key: Key,
    value_repr: ValueRepr, // Changed from `value: Value`
    level: u8,
) -> Pin<Box<dyn Future<Output = Result<ProcessedNodeUpdate>> + Send + 's>> {
    Box::pin(async move {
        let mut current_node_obj = tree.load_node(&current_node_hash).await?;

        match &mut current_node_obj {
            Node::Leaf { entries, .. } => {
                match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                    Ok(index) => entries[index].value = value_repr,
                    Err(index) => entries.insert(index, LeafEntry { key, value: value_repr }),
                }

                let current_leaf_item_count = entries.len() as u64;

                if entries.len() > tree.config.target_fanout { // Leaf splits
                    let mid_idx = entries.len() / 2;
                    let right_sibling_entries = entries.split_off(mid_idx);
                    
                    let left_split_item_count = entries.len() as u64;
                    let right_split_item_count = right_sibling_entries.len() as u64;

                    let right_sibling_boundary_key = right_sibling_entries.last().ok_or_else(|| ProllyError::InternalError("Split leaf created empty right sibling".to_string()))?.key.clone();
                    let right_sibling_node = Node::Leaf { level: 0, entries: right_sibling_entries };
                    let (_r_b, right_sibling_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &right_sibling_node).await?;

                    let (left_boundary_key, left_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;

                    Ok(ProcessedNodeUpdate {
                        new_hash: left_hash,
                        new_boundary_key: left_boundary_key,
                        new_item_count: left_split_item_count,
                        split_info: Some((right_sibling_boundary_key, right_sibling_hash, right_split_item_count)),
                    })
                } else { // Leaf does not split
                    let (new_boundary_key, new_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;
                    Ok(ProcessedNodeUpdate {
                        new_hash,
                        new_boundary_key,
                        new_item_count: current_leaf_item_count,
                        split_info: None,
                    })
                }
            }
            Node::Internal { children, .. } => {
                let mut child_idx_to_descend = children.len() - 1;
                for (idx, child_entry) in children.iter().enumerate() {
                    if key.as_slice() <= &child_entry.boundary_key {
                        child_idx_to_descend = idx;
                        break;
                    }
                }

                let child_to_descend_hash = children[child_idx_to_descend].child_hash;
                let child_level = level - 1; // current_node_obj.level() is level, so child is level - 1

                let child_update_result = insert_recursive_impl(tree, child_to_descend_hash, key, value_repr, child_level).await?;

                children[child_idx_to_descend].child_hash = child_update_result.new_hash;
                children[child_idx_to_descend].boundary_key = child_update_result.new_boundary_key;
                children[child_idx_to_descend].num_items_subtree = child_update_result.new_item_count;

                let mut split_to_propagate_upwards: Option<(Key, Hash, u64)> = None;

                if let Some((boundary_from_child_split, new_child_sibling_hash, child_sibling_item_count)) = child_update_result.split_info {
                    let new_internal_entry = InternalEntry {
                        boundary_key: boundary_from_child_split,
                        child_hash: new_child_sibling_hash,
                        num_items_subtree: child_sibling_item_count,
                    };

                    let pos_to_insert_sibling = children.binary_search_by_key(&&new_internal_entry.boundary_key, |e| &e.boundary_key).unwrap_or_else(|e| e);
                    children.insert(pos_to_insert_sibling, new_internal_entry);

                    if children.len() > tree.config.target_fanout { // Internal node itself splits
                        let mid_idx = children.len() / 2;
                        let right_sibling_children_entries = children.split_off(mid_idx);
                        
                        let _left_internal_node_item_count: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                        let right_internal_node_item_count: u64 = right_sibling_children_entries.iter().map(|c| c.num_items_subtree).sum();

                        let right_sibling_boundary_key = right_sibling_children_entries.last().ok_or_else(|| ProllyError::InternalError("Split internal created empty right sibling".to_string()))?.boundary_key.clone();
                        let right_sibling_node = Node::Internal { level, children: right_sibling_children_entries };
                        let (_r_b, right_sibling_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &right_sibling_node).await?;

                        split_to_propagate_upwards = Some((right_sibling_boundary_key, right_sibling_hash, right_internal_node_item_count));
                    }
                }
                
                let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                let (current_node_new_boundary, current_node_new_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;

                Ok(ProcessedNodeUpdate {
                    new_hash: current_node_new_hash,
                    new_boundary_key: current_node_new_boundary,
                    new_item_count: current_node_total_items,
                    split_info: split_to_propagate_upwards,
                })
            }
        }
    })
}

pub(super) fn delete_recursive_impl<'s, S: ChunkStore + 's>(
    tree: &'s ProllyTree<S>,
    node_hash: Hash,
    key: &'s Key,
    level: u8,
    key_actually_deleted_flag: &'s mut bool,
) -> Pin<Box<dyn Future<Output = Result<DeleteRecursionResult>> + Send + 's>> {
    Box::pin(async move {
        let mut current_node_obj = tree.load_node(&node_hash).await?;

        match &mut current_node_obj {
            Node::Leaf { entries, .. } => {
                match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                    Ok(index) => {
                        *key_actually_deleted_flag = true;
                        entries.remove(index);
                        if entries.is_empty() {
                            return Ok(DeleteRecursionResult::Merged);
                        } else {
                            let new_leaf_item_count = entries.len() as u64;
                            let (new_boundary, new_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;
                            Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate {
                                new_hash,
                                new_boundary_key: new_boundary,
                                new_item_count: new_leaf_item_count,
                                split_info: None,
                            }))
                        }
                    }
                    Err(_) => {
                        let boundary_key = entries.last().map(|e| e.key.clone())
                            .ok_or_else(|| ProllyError::InternalError("Cannot get boundary key from empty leaf (key not found path)".to_string()))?;
                        Ok(DeleteRecursionResult::NotFound { node_hash, boundary_key })
                    }
                }
            }
            Node::Internal { children, .. } => {
                if children.is_empty() {
                    return Err(ProllyError::InternalError("Internal node has no children during delete.".to_string()));
                }
                let mut child_idx_to_descend = children.len() - 1;
                for (idx, child_entry) in children.iter().enumerate() {
                    if key.as_slice() <= &child_entry.boundary_key {
                        child_idx_to_descend = idx;
                        break;
                    }
                }

                let child_hash_to_descend = children[child_idx_to_descend].child_hash;
                 if level == 0 { // current node is internal, so level must be > 0
                     return Err(ProllyError::InternalError("Internal node level is 0, cannot descend further for delete.".to_string()));
                }
                let child_level = level - 1;

                let child_delete_result = delete_recursive_impl(tree, child_hash_to_descend, key, child_level, key_actually_deleted_flag).await?;

                match child_delete_result {
                    DeleteRecursionResult::NotFound { node_hash: _child_node_hash, boundary_key: _child_boundary_key } => {
                        let current_internal_node_boundary_key = children.last().map(|ce| ce.boundary_key.clone())
                            .ok_or_else(|| ProllyError::InternalError("Internal node empty during NotFound propagation".to_string()))?;
                        Ok(DeleteRecursionResult::NotFound {
                            node_hash, // original hash of *this* internal node
                            boundary_key: current_internal_node_boundary_key,
                        })
                    }
                    DeleteRecursionResult::Updated(child_update) => {
                        children[child_idx_to_descend].child_hash = child_update.new_hash;
                        children[child_idx_to_descend].boundary_key = child_update.new_boundary_key;
                        children[child_idx_to_descend].num_items_subtree = child_update.new_item_count;

                        let child_node_after_update = tree.load_node(&child_update.new_hash).await?;
                        if child_node_after_update.is_underflow(&tree.config) {
                            modification::handle_underflow_strategy(tree, children, child_idx_to_descend).await?;
                            if children.is_empty() { // Current internal node itself merged away
                                return Ok(DeleteRecursionResult::Merged);
                            }
                        }
                        
                        let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                        let (new_boundary, new_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;
                        Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate {
                            new_hash,
                            new_boundary_key: new_boundary,
                            new_item_count: current_node_total_items,
                            split_info: None,
                        }))
                    }
                    DeleteRecursionResult::Merged => {
                        children.remove(child_idx_to_descend);

                        if children.is_empty() {
                            return Ok(DeleteRecursionResult::Merged);
                        }
                        
                        let current_node_total_items: u64 = children.iter().map(|c| c.num_items_subtree).sum();
                        let (new_boundary, new_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &current_node_obj).await?;
                        Ok(DeleteRecursionResult::Updated(ProcessedNodeUpdate {
                            new_hash,
                            new_boundary_key: new_boundary,
                            new_item_count: current_node_total_items,
                            split_info: None,
                        }))
                    }
                }
            }
        }
    })
}