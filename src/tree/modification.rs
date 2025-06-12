use crate::node::definition::{Node, InternalEntry};
use crate::store::ChunkStore;
use crate::error::{Result, ProllyError};

use super::prolly_tree::ProllyTree;
use super::io;

/// Renamed from `handle_underflow` to avoid conflict if ProllyTree retains a method with that name,
/// and to indicate it's a strategic choice point.
pub(super) async fn handle_underflow_strategy<S: ChunkStore>(
    tree: &ProllyTree<S>,
    children: &mut Vec<InternalEntry>, // Parent's children list
    underflow_child_idx: usize,        // Index of the child that is underflow
) -> Result<()> {
    // Try borrowing from left sibling
    if underflow_child_idx > 0 {
        let left_sibling_idx = underflow_child_idx - 1;
        let left_sibling_node = tree.load_node(&children[left_sibling_idx].child_hash).await?;
        if left_sibling_node.num_entries() > tree.config.min_fanout {
            rebalance_borrow_from_left(tree, children, left_sibling_idx, underflow_child_idx).await?;
            return Ok(());
        }
    }

    // Try borrowing from right sibling
    if underflow_child_idx + 1 < children.len() {
        let right_sibling_idx = underflow_child_idx + 1;
        let right_sibling_node = tree.load_node(&children[right_sibling_idx].child_hash).await?;
        if right_sibling_node.num_entries() > tree.config.min_fanout {
            rebalance_borrow_from_right(tree, children, underflow_child_idx, right_sibling_idx).await?;
            return Ok(());
        }
    }

    // Cannot borrow, must merge. Prefer merging with left sibling if possible.
    if underflow_child_idx > 0 {
        let left_idx = underflow_child_idx - 1;
        let right_idx = underflow_child_idx;
        merge_into_left_sibling_internal(tree, children, left_idx, right_idx).await?;
    } else {
        // Must merge with right sibling (underflow_child_idx must be 0).
        // Ensure there is a right sibling to merge with.
        if children.len() <= 1 {
             return Err(ProllyError::InternalError("Underflow node has no sibling to merge with.".to_string()));
        }
        let left_idx = underflow_child_idx; // This is the underflow node
        let right_idx = underflow_child_idx + 1; // This is the sibling it will merge with (or into)
        merge_into_left_sibling_internal(tree, children, left_idx, right_idx).await?;
    }

    Ok(())
}

async fn rebalance_borrow_from_left<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    left_sibling_idx_in_parent: usize,
    underflow_node_idx_in_parent: usize,
) -> Result<()> {
    let mut left_node_obj = tree.load_node(&parent_children_vec[left_sibling_idx_in_parent].child_hash).await?;
    let mut underflow_node_obj = tree.load_node(&parent_children_vec[underflow_node_idx_in_parent].child_hash).await?;

    match (&mut left_node_obj, &mut underflow_node_obj) {
        (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: underflow_entries, .. }) => {
            if let Some(borrowed_entry) = left_entries.pop() {
                underflow_entries.insert(0, borrowed_entry);
            } else {
                return Err(ProllyError::InternalError("Attempted to borrow from empty left leaf sibling".to_string()));
            }
        }
        (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: underflow_children_entries, .. }) => {
            if let Some(borrowed_child_internal_entry) = left_children_entries.pop() {
                underflow_children_entries.insert(0, borrowed_child_internal_entry);
            } else {
                return Err(ProllyError::InternalError("Attempted to borrow from empty left internal sibling".to_string()));
            }
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance from left".to_string())),
    }

    let new_left_node_item_count = match &left_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let new_underflow_node_item_count = match &underflow_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };

    let (new_left_boundary, new_left_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &left_node_obj).await?;
    let (new_underflow_boundary, new_underflow_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &underflow_node_obj).await?;

    parent_children_vec[left_sibling_idx_in_parent].boundary_key = new_left_boundary;
    parent_children_vec[left_sibling_idx_in_parent].child_hash = new_left_hash;
    parent_children_vec[left_sibling_idx_in_parent].num_items_subtree = new_left_node_item_count;

    parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary;
    parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
    parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count;

    Ok(())
}

async fn rebalance_borrow_from_right<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    underflow_node_idx_in_parent: usize,
    right_sibling_idx_in_parent: usize,
) -> Result<()> {
    let mut underflow_node_obj = tree.load_node(&parent_children_vec[underflow_node_idx_in_parent].child_hash).await?;
    let mut right_node_obj = tree.load_node(&parent_children_vec[right_sibling_idx_in_parent].child_hash).await?;

    match (&mut underflow_node_obj, &mut right_node_obj) {
        (Node::Leaf { entries: underflow_entries, .. }, Node::Leaf { entries: right_entries, .. }) => {
            if right_entries.is_empty() {
                return Err(ProllyError::InternalError("Attempted to borrow from empty right leaf sibling".to_string()));
            }
            let borrowed_entry = right_entries.remove(0);
            underflow_entries.push(borrowed_entry);
        }
        (Node::Internal { children: underflow_children_entries, .. }, Node::Internal { children: right_children_entries, .. }) => {
            if right_children_entries.is_empty() {
                return Err(ProllyError::InternalError("Attempted to borrow from empty right internal sibling".to_string()));
            }
            let borrowed_child_internal_entry = right_children_entries.remove(0);
            underflow_children_entries.push(borrowed_child_internal_entry);
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance from right".to_string())),
    }

    let new_underflow_node_item_count = match &underflow_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let new_right_node_item_count = match &right_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };

    let (new_underflow_boundary, new_underflow_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &underflow_node_obj).await?;
    let (new_right_boundary, new_right_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &right_node_obj).await?;

    parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary;
    parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
    parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count;

    parent_children_vec[right_sibling_idx_in_parent].boundary_key = new_right_boundary;
    parent_children_vec[right_sibling_idx_in_parent].child_hash = new_right_hash;
    parent_children_vec[right_sibling_idx_in_parent].num_items_subtree = new_right_node_item_count;
    
    Ok(())
}

/// Merges the node at `right_idx_in_parent` into the node at `left_idx_in_parent`.
/// The entry for `right_idx_in_parent` is removed from `parent_children_vec`.
async fn merge_into_left_sibling_internal<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    left_idx_in_parent: usize,
    right_idx_in_parent: usize,
) -> Result<()> {
    if left_idx_in_parent + 1 != right_idx_in_parent {
        return Err(ProllyError::InternalError(format!(
            "Attempted to merge non-adjacent siblings: left_idx={}, right_idx={}",
            left_idx_in_parent, right_idx_in_parent
        )));
    }
     if right_idx_in_parent >= parent_children_vec.len() {
        return Err(ProllyError::InternalError(format!(
            "Right sibling index {} is out of bounds for parent_children_vec with length {}",
            right_idx_in_parent, parent_children_vec.len()
        )));
    }


    let items_from_left_child_before_merge = parent_children_vec[left_idx_in_parent].num_items_subtree;
    let items_from_right_child_before_merge = parent_children_vec[right_idx_in_parent].num_items_subtree;

    let mut left_node_obj = tree.load_node(&parent_children_vec[left_idx_in_parent].child_hash).await?;
    let right_node_to_merge_obj = tree.load_node(&parent_children_vec[right_idx_in_parent].child_hash).await?;

    match (&mut left_node_obj, right_node_to_merge_obj) {
        (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: mut right_entries_to_append, .. }) => {
            left_entries.append(&mut right_entries_to_append);
        }
        (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: mut right_children_to_append, .. }) => {
            left_children_entries.append(&mut right_children_to_append);
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during merge".to_string())),
    }

    let (new_merged_node_boundary, new_merged_node_hash) = io::store_node_and_get_key_hash_pair(&tree.store, &left_node_obj).await?;

    parent_children_vec[left_idx_in_parent].boundary_key = new_merged_node_boundary;
    parent_children_vec[left_idx_in_parent].child_hash = new_merged_node_hash;
    parent_children_vec[left_idx_in_parent].num_items_subtree = items_from_left_child_before_merge + items_from_right_child_before_merge;

    parent_children_vec.remove(right_idx_in_parent);

    Ok(())
}

// SYNC

pub(super) fn handle_underflow_strategy_sync<S: ChunkStore>(
    tree: &ProllyTree<S>,
    children: &mut Vec<InternalEntry>,
    underflow_child_idx: usize,
) -> Result<()> {
    if underflow_child_idx > 0 {
        let left_sibling_idx = underflow_child_idx - 1;
        let left_sibling_node = tree.load_node_sync(&children[left_sibling_idx].child_hash)?;
        if left_sibling_node.num_entries() > tree.config.min_fanout {
            rebalance_borrow_from_left_sync(tree, children, left_sibling_idx, underflow_child_idx)?;
            return Ok(());
        }
    }
    if underflow_child_idx + 1 < children.len() {
        let right_sibling_idx = underflow_child_idx + 1;
        let right_sibling_node = tree.load_node_sync(&children[right_sibling_idx].child_hash)?;
        if right_sibling_node.num_entries() > tree.config.min_fanout {
            rebalance_borrow_from_right_sync(tree, children, underflow_child_idx, right_sibling_idx)?;
            return Ok(());
        }
    }
    if underflow_child_idx > 0 {
        let left_idx = underflow_child_idx - 1;
        let right_idx = underflow_child_idx;
        merge_into_left_sibling_internal_sync(tree, children, left_idx, right_idx)?;
    } else {
        if children.len() <= 1 {
            return Err(ProllyError::InternalError("Underflow node has no sibling to merge with.".to_string()));
        }
        let left_idx = underflow_child_idx;
        let right_idx = underflow_child_idx + 1;
        merge_into_left_sibling_internal_sync(tree, children, left_idx, right_idx)?;
    }
    Ok(())
}

fn rebalance_borrow_from_left_sync<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    left_sibling_idx_in_parent: usize,
    underflow_node_idx_in_parent: usize,
) -> Result<()> {
    let mut left_node_obj = tree.load_node_sync(&parent_children_vec[left_sibling_idx_in_parent].child_hash)?;
    let mut underflow_node_obj = tree.load_node_sync(&parent_children_vec[underflow_node_idx_in_parent].child_hash)?;
    match (&mut left_node_obj, &mut underflow_node_obj) {
        (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: underflow_entries, .. }) => {
            if let Some(borrowed_entry) = left_entries.pop() {
                underflow_entries.insert(0, borrowed_entry);
            } else {
                return Err(ProllyError::InternalError("Attempted to borrow from empty left leaf sibling".to_string()));
            }
        }
        (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: underflow_children_entries, .. }) => {
            if let Some(borrowed_child_internal_entry) = left_children_entries.pop() {
                underflow_children_entries.insert(0, borrowed_child_internal_entry);
            } else {
                return Err(ProllyError::InternalError("Attempted to borrow from empty left internal sibling".to_string()));
            }
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance from left".to_string())),
    }
    let new_left_node_item_count = match &left_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let new_underflow_node_item_count = match &underflow_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let (new_left_boundary, new_left_hash) = io::store_node_and_get_key_hash_pair_sync(&tree.store, &left_node_obj)?;
    let (new_underflow_boundary, new_underflow_hash) = io::store_node_and_get_key_hash_pair_sync(&tree.store, &underflow_node_obj)?;
    parent_children_vec[left_sibling_idx_in_parent].boundary_key = new_left_boundary;
    parent_children_vec[left_sibling_idx_in_parent].child_hash = new_left_hash;
    parent_children_vec[left_sibling_idx_in_parent].num_items_subtree = new_left_node_item_count;
    parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary;
    parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
    parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count;
    Ok(())
}

fn rebalance_borrow_from_right_sync<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    underflow_node_idx_in_parent: usize,
    right_sibling_idx_in_parent: usize,
) -> Result<()> {
    let mut underflow_node_obj = tree.load_node_sync(&parent_children_vec[underflow_node_idx_in_parent].child_hash)?;
    let mut right_node_obj = tree.load_node_sync(&parent_children_vec[right_sibling_idx_in_parent].child_hash)?;
    match (&mut underflow_node_obj, &mut right_node_obj) {
        (Node::Leaf { entries: underflow_entries, .. }, Node::Leaf { entries: right_entries, .. }) => {
            if right_entries.is_empty() {
                return Err(ProllyError::InternalError("Attempted to borrow from empty right leaf sibling".to_string()));
            }
            let borrowed_entry = right_entries.remove(0);
            underflow_entries.push(borrowed_entry);
        }
        (Node::Internal { children: underflow_children_entries, .. }, Node::Internal { children: right_children_entries, .. }) => {
            if right_children_entries.is_empty() {
                return Err(ProllyError::InternalError("Attempted to borrow from empty right internal sibling".to_string()));
            }
            let borrowed_child_internal_entry = right_children_entries.remove(0);
            underflow_children_entries.push(borrowed_child_internal_entry);
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during rebalance from right".to_string())),
    }
    let new_underflow_node_item_count = match &underflow_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let new_right_node_item_count = match &right_node_obj {
        Node::Leaf { entries, .. } => entries.len() as u64,
        Node::Internal { children: c, .. } => c.iter().map(|entry| entry.num_items_subtree).sum(),
    };
    let (new_underflow_boundary, new_underflow_hash) = io::store_node_and_get_key_hash_pair_sync(&tree.store, &underflow_node_obj)?;
    let (new_right_boundary, new_right_hash) = io::store_node_and_get_key_hash_pair_sync(&tree.store, &right_node_obj)?;
    parent_children_vec[underflow_node_idx_in_parent].boundary_key = new_underflow_boundary;
    parent_children_vec[underflow_node_idx_in_parent].child_hash = new_underflow_hash;
    parent_children_vec[underflow_node_idx_in_parent].num_items_subtree = new_underflow_node_item_count;
    parent_children_vec[right_sibling_idx_in_parent].boundary_key = new_right_boundary;
    parent_children_vec[right_sibling_idx_in_parent].child_hash = new_right_hash;
    parent_children_vec[right_sibling_idx_in_parent].num_items_subtree = new_right_node_item_count;
    Ok(())
}

fn merge_into_left_sibling_internal_sync<S: ChunkStore>(
    tree: &ProllyTree<S>,
    parent_children_vec: &mut Vec<InternalEntry>,
    left_idx_in_parent: usize,
    right_idx_in_parent: usize,
) -> Result<()> {
    if left_idx_in_parent + 1 != right_idx_in_parent {
        return Err(ProllyError::InternalError(format!(
            "Attempted to merge non-adjacent siblings: left_idx={}, right_idx={}",
            left_idx_in_parent, right_idx_in_parent
        )));
    }
    if right_idx_in_parent >= parent_children_vec.len() {
        return Err(ProllyError::InternalError(format!(
            "Right sibling index {} is out of bounds for parent_children_vec with length {}",
            right_idx_in_parent, parent_children_vec.len()
        )));
    }
    let items_from_left_child_before_merge = parent_children_vec[left_idx_in_parent].num_items_subtree;
    let items_from_right_child_before_merge = parent_children_vec[right_idx_in_parent].num_items_subtree;
    let mut left_node_obj = tree.load_node_sync(&parent_children_vec[left_idx_in_parent].child_hash)?;
    let right_node_to_merge_obj = tree.load_node_sync(&parent_children_vec[right_idx_in_parent].child_hash)?;
    match (&mut left_node_obj, right_node_to_merge_obj) {
        (Node::Leaf { entries: left_entries, .. }, Node::Leaf { entries: mut right_entries_to_append, .. }) => {
            left_entries.append(&mut right_entries_to_append);
        }
        (Node::Internal { children: left_children_entries, .. }, Node::Internal { children: mut right_children_to_append, .. }) => {
            left_children_entries.append(&mut right_children_to_append);
        }
        _ => return Err(ProllyError::InternalError("Mismatched node types during merge".to_string())),
    }
    let (new_merged_node_boundary, new_merged_node_hash) = io::store_node_and_get_key_hash_pair_sync(&tree.store, &left_node_obj)?;
    parent_children_vec[left_idx_in_parent].boundary_key = new_merged_node_boundary;
    parent_children_vec[left_idx_in_parent].child_hash = new_merged_node_hash;
    parent_children_vec[left_idx_in_parent].num_items_subtree = items_from_left_child_before_merge + items_from_right_child_before_merge;
    parent_children_vec.remove(right_idx_in_parent);
    Ok(())
}