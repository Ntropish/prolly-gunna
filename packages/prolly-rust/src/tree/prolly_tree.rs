// prolly-rust/src/tree/prolly_tree.rs

use std::sync::Arc;
use std::pin::Pin; // Required for Box::pin
use std::future::Future; // Required for type hinting the boxed future

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, LeafEntry, InternalEntry, ValueRepr};
use crate::store::ChunkStore;
use crate::chunk::chunk_node;

/// The main Prolly Tree structure.
#[derive(Debug)]
pub struct ProllyTree<S: ChunkStore> {
    pub root_hash: Option<Hash>,
    pub store: Arc<S>,
    pub config: TreeConfig,
}

/// Carries information about a node update, including its new state (hash, boundary)
/// and any new sibling created by a split.
#[derive(Debug)]
struct ProcessedNodeUpdate {
    new_hash: Hash,
    new_boundary_key: Key,
    split_info: Option<(Key, Hash)>,
}


impl<S: ChunkStore> ProllyTree<S> {
    pub fn new(store: Arc<S>, config: TreeConfig) -> Self {
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
            panic!("Invalid TreeConfig: fanout values are not configured properly. min_fanout must be > 0, target_fanout >= 2 * min_fanout.");
        }
        ProllyTree {
            root_hash: None,
            store,
            config,
        }
    }

    pub async fn from_root_hash(
        root_hash: Hash,
        store: Arc<S>,
        config: TreeConfig,
    ) -> Result<Self> {
        match store.get(&root_hash).await? {
            Some(bytes) => {
                Node::decode(&bytes)?;
                Ok(ProllyTree {
                    root_hash: Some(root_hash),
                    store,
                    config,
                })
            }
            None => Err(ProllyError::ChunkNotFound(root_hash)),
        }
    }

    pub fn get_root_hash(&self) -> Option<Hash> {
        self.root_hash
    }

    async fn load_node(&self, hash: &Hash) -> Result<Node> {
        let bytes = self.store.get(hash).await?
            .ok_or_else(|| ProllyError::ChunkNotFound(*hash))?;
        Node::decode(&bytes)
    }

    async fn store_node_and_get_key_hash_pair(&self, node: &Node) -> Result<(Key, Hash)> {
        let (hash, bytes) = chunk_node(node)?;
        self.store.put(bytes).await?;
        
        let boundary_key = match node {
            Node::Leaf { entries, .. } => entries.last().map(|e| e.key.clone())
                .ok_or_else(|| ProllyError::InternalError("Cannot get boundary key from empty leaf".to_string()))?,
            Node::Internal { children, .. } => children.last().map(|ce| ce.boundary_key.clone())
                .ok_or_else(|| ProllyError::InternalError("Cannot get boundary key from empty internal node".to_string()))?,
        };
        Ok((boundary_key, hash))
    }
    
    pub async fn get(&self, key: &Key) -> Result<Option<Value>> {
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(None),
        };
        // For the public API, the first call isn't "recursive" in the sense of needing boxing itself,
        // it calls the helper that is.
        self.recursive_get_impl(current_root_hash, key.clone()).await // Pass owned key for lifetime 'static
    }
    
    // Renamed to _impl and changed signature for boxing
    // The 's lifetime here means the returned Future is tied to &self.
    // For Box::pin to create a 'static future, we often need to pass owned data or use Arcs.
    // Let's adjust to take owned Key or ensure data is 'static for the boxed future.
    fn recursive_get_impl<'s>(
        &'s self, // Keep &self as methods operate on the tree's store/config
        node_hash: Hash,
        key: Key, // Take owned Key to allow moving into the Box::pin future
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 's>> {
        Box::pin(async move { // async move block captures variables by move
            let node = self.load_node(&node_hash).await?;
            match node {
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by(|e| e.key.as_slice().cmp(key.as_slice())) {
                        Ok(index) => {
                            let entry = &entries[index];
                            match &entry.value {
                                ValueRepr::Inline(val) => Ok(Some(val.clone())),
                                ValueRepr::Chunked(data_hash) => {
                                    let value_bytes = self.store.get(data_hash).await?
                                        .ok_or_else(|| ProllyError::ChunkNotFound(*data_hash))?;
                                    Ok(Some(value_bytes))
                                }
                            }
                        }
                        Err(_) => Ok(None),
                    }
                }
                Node::Internal { children, .. } => {
                    if children.is_empty() { return Ok(None); }

                    let mut child_idx_to_search = children.len() -1; 
                    for (idx, child_entry) in children.iter().enumerate() {
                        if key.as_slice() <= &child_entry.boundary_key { // Compare key.as_slice() with &Vec<u8>
                            child_idx_to_search = idx;
                            break;
                        }
                    }
                    // Recursive call is now boxed
                    self.recursive_get_impl(children[child_idx_to_search].child_hash, key).await
                }
            }
        })
    }

    pub async fn insert(&mut self, key: Key, value: Value) -> Result<()> {
        let value_repr = self.prepare_value_repr(value).await?;

        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => {
                let new_leaf_node = Node::Leaf {
                    level: 0,
                    entries: vec![LeafEntry { key, value: value_repr }],
                };
                let (_boundary_key, new_root_hash_val) = self.store_node_and_get_key_hash_pair(&new_leaf_node).await?;
                self.root_hash = Some(new_root_hash_val);
                return Ok(());
            }
        };
        
        let root_node = self.load_node(&current_root_hash).await?;
        // Pass owned key and value_repr for boxing
        let update_result = self.recursive_insert_impl(current_root_hash, key, value_repr, root_node.level()).await?;

        self.root_hash = Some(update_result.new_hash); 

        if let Some((split_boundary_key, new_sibling_hash)) = update_result.split_info {
            let old_root_as_left_child_boundary = update_result.new_boundary_key; 
            
            let new_root_children = vec![
                InternalEntry {
                    boundary_key: old_root_as_left_child_boundary,
                    child_hash: self.root_hash.unwrap(), 
                },
                InternalEntry {
                    boundary_key: split_boundary_key, 
                    child_hash: new_sibling_hash,
                },
            ];
            
            let new_root_level = root_node.level() + 1;
            let new_root_node_obj = Node::new_internal(new_root_children, new_root_level)?;
            let (_final_boundary, final_root_hash) = self.store_node_and_get_key_hash_pair(&new_root_node_obj).await?;
            self.root_hash = Some(final_root_hash);
        }
        Ok(())
    }

    async fn prepare_value_repr(&self, value: Value) -> Result<ValueRepr> {
        Ok(ValueRepr::Inline(value))
    }
    
    // Changed to non-async, returns a Pinned Future. Takes owned Key & ValueRepr.
    // The 's lifetime here means the returned Future is tied to &mut self.
    fn recursive_insert_impl<'s>(
        &'s mut self,
        node_hash: Hash,
        key: Key, // Owned
        value: ValueRepr, // Owned
        level: u8,
    ) -> Pin<Box<dyn Future<Output = Result<ProcessedNodeUpdate>> + Send + 's>> {
        Box::pin(async move { // async move block
            let mut current_node_obj = self.load_node(&node_hash).await?;

            match &mut current_node_obj {
                Node::Leaf { entries, .. } => {
                    match entries.binary_search_by_key(&&key, |e| &e.key) { // Pass &key for owned key
                        Ok(index) => entries[index].value = value,
                        Err(index) => entries.insert(index, LeafEntry { key, value }),
                    }

                    if entries.len() > self.config.target_fanout {
                        let mid_idx = entries.len() / 2;
                        let right_sibling_entries = entries.split_off(mid_idx); 

                        let right_sibling_boundary_key = right_sibling_entries.last().ok_or_else(|| ProllyError::InternalError("Split leaf created empty right sibling".to_string()))?.key.clone();
                        let right_sibling_node = Node::Leaf { level: 0, entries: right_sibling_entries };
                        let (_r_boundary, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;
                        
                        let (left_boundary_key, left_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                        Ok(ProcessedNodeUpdate {
                            new_hash: left_hash,
                            new_boundary_key: left_boundary_key,
                            split_info: Some((right_sibling_boundary_key, right_sibling_hash)),
                        })
                    } else {
                        let (new_boundary_key, new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;
                        Ok(ProcessedNodeUpdate { new_hash, new_boundary_key, split_info: None })
                    }
                }
                Node::Internal { children, .. } => {
                    let mut child_idx_to_descend = children.len() -1;
                    for (idx, child_entry) in children.iter().enumerate() {
                        if key.as_slice() <= &child_entry.boundary_key { // Compare key.as_slice()
                            child_idx_to_descend = idx;
                            break;
                        }
                    }
                    
                    let child_to_descend_hash = children[child_idx_to_descend].child_hash;
                    let child_level = level - 1; 

                    // Recursive call is now boxed
                    let child_update_result = self.recursive_insert_impl(child_to_descend_hash, key, value, child_level).await?;

                    children[child_idx_to_descend].child_hash = child_update_result.new_hash;
                    children[child_idx_to_descend].boundary_key = child_update_result.new_boundary_key;

                    let mut split_to_propagate = None;

                    if let Some((boundary_from_child_split, new_child_sibling_hash)) = child_update_result.split_info {
                        let new_internal_entry = InternalEntry {
                            boundary_key: boundary_from_child_split,
                            child_hash: new_child_sibling_hash,
                        };
                        
                        let pos_to_insert_sibling = children.binary_search_by_key(&&new_internal_entry.boundary_key, |e| &e.boundary_key).unwrap_or_else(|e| e);
                        children.insert(pos_to_insert_sibling, new_internal_entry);

                        if children.len() > self.config.target_fanout {
                            let mid_idx = children.len() / 2;
                            let right_sibling_children = children.split_off(mid_idx);

                            let right_sibling_boundary_key = right_sibling_children.last().ok_or_else(|| ProllyError::InternalError("Split internal created empty right sibling".to_string()))?.boundary_key.clone();
                            let right_sibling_node = Node::Internal { level, children: right_sibling_children }; 
                            let (_r_boundary, right_sibling_hash) = self.store_node_and_get_key_hash_pair(&right_sibling_node).await?;
                            
                            split_to_propagate = Some((right_sibling_boundary_key, right_sibling_hash));
                        }
                    }
                    
                    let (current_node_new_boundary, current_node_new_hash) = self.store_node_and_get_key_hash_pair(&current_node_obj).await?;

                    Ok(ProcessedNodeUpdate {
                        new_hash: current_node_new_hash,
                        new_boundary_key: current_node_new_boundary,
                        split_info: split_to_propagate,
                    })
                }
            }
        })
    }
    
    pub async fn delete(&mut self, _key: &Key) -> Result<bool> {
        unimplemented!("delete operation not yet fully implemented");
    }

    pub async fn commit(&mut self) -> Result<Option<Hash>> {
        Ok(self.root_hash)
    }
}