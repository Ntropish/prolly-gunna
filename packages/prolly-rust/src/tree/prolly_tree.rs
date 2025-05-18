use std::sync::Arc;
use std::pin::Pin;
use std::future::Future;

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, LeafEntry, InternalEntry, ValueRepr};
use crate::store::ChunkStore;
use crate::diff::{diff_trees, DiffEntry};
use crate::gc::GarbageCollector;

use super::cursor::Cursor;
use super::types::{ScanArgs, ScanPage, ProcessedNodeUpdate, DeleteRecursionResult}; 
use super::{io, core_logic};


#[derive(Debug)]
pub struct ProllyTree<S: ChunkStore> {
    pub root_hash: Option<Hash>,
    pub store: Arc<S>,
    pub config: TreeConfig,
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

    pub(crate) async fn load_node(&self, hash: &Hash) -> Result<Node> {
        let bytes = self.store.get(hash).await?
            .ok_or_else(|| ProllyError::ChunkNotFound(*hash))?;
        Node::decode(&bytes)
    }

    pub async fn from_root_hash(
        root_hash: Hash,
        store: Arc<S>,
        config: TreeConfig,
    ) -> Result<Self> {
        // Validate config like in new()
        if config.min_fanout == 0 || config.target_fanout < config.min_fanout * 2 || config.target_fanout == 0 {
            // Or return a Result::Err
            panic!("Invalid TreeConfig for from_root_hash");
        }
        match store.get(&root_hash).await? {
            Some(bytes) => {
                Node::decode(&bytes)?; // Ensure root hash points to a valid node
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

    pub async fn get(&self, key: &Key) -> Result<Option<Value>> {
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(None),
        };
        // Delegate to core_logic
        self.recursive_get_impl(current_root_hash, key.clone()).await
    }
    
    // Wrapper for core_logic's implementation
    fn recursive_get_impl<'s>(
        &'s self,
        node_hash: Hash,
        key: Key,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 's>>
    where S: 's { // Ensure S outlives 's for self.store and self.config
        Box::pin(core_logic::get_recursive_impl(self, node_hash, key))
    }


    pub async fn insert(&mut self, key: Key, value: Value) -> Result<()> {
        let value_repr = io::prepare_value_repr(&self.store, &self.config, value).await?;

        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => {
                // Create new root leaf directly
                let new_leaf_node = Node::Leaf {
                    level: 0,
                    entries: vec![LeafEntry { key, value: value_repr }],
                };
                // Use io module to store it
                let (_boundary_key, new_root_hash_val) = io::store_node_and_get_key_hash_pair(&self.store, &new_leaf_node).await?;
                self.root_hash = Some(new_root_hash_val);
                return Ok(());
            }
        };
        
        let root_node = self.load_node(&current_root_hash).await?; // Need level of root
        // Delegate to core_logic's recursive_insert_impl
        let update_result = self.recursive_insert_impl(current_root_hash, key, value_repr, root_node.level()).await?;

        self.root_hash = Some(update_result.new_hash);

        if let Some((split_boundary_key, new_sibling_hash, new_sibling_item_count)) = update_result.split_info {
            let old_root_as_left_child_boundary = update_result.new_boundary_key;
            let old_root_as_left_child_item_count = update_result.new_item_count;

            let new_root_children = vec![
                InternalEntry {
                    boundary_key: old_root_as_left_child_boundary,
                    child_hash: self.root_hash.unwrap(), // This is new_hash from update_result
                    num_items_subtree: old_root_as_left_child_item_count,
                },
                InternalEntry {
                    boundary_key: split_boundary_key,
                    child_hash: new_sibling_hash,
                    num_items_subtree: new_sibling_item_count,
                },
            ];

            let new_root_level = root_node.level() + 1;
            let new_root_node_obj = Node::new_internal(new_root_children, new_root_level)?;
            let (_final_boundary, final_root_hash) = io::store_node_and_get_key_hash_pair(&self.store, &new_root_node_obj).await?;
            self.root_hash = Some(final_root_hash);
        }
        Ok(())
    }

    // Wrapper for core_logic's implementation
    fn recursive_insert_impl<'s>(
        &'s self, // Pass &self as core_logic needs access to store, config via tree
        node_hash: Hash,
        key: Key,
        value_repr: ValueRepr,
        level: u8,
    ) -> Pin<Box<dyn Future<Output = Result<ProcessedNodeUpdate>> + Send + 's>> 
    where S: 's {
        Box::pin(core_logic::insert_recursive_impl(self, node_hash, key, value_repr, level))
    }


    pub async fn insert_batch(&mut self, items: Vec<(Key, Value)>) -> Result<()> {
        for (key, value) in items {
            self.insert(key, value).await?;
        }
        Ok(())
    }

    pub async fn delete(&mut self, key: &Key) -> Result<bool> {
        let current_root_hash = match self.root_hash {
            Some(h) => h,
            None => return Ok(false),
        };

        let root_node = self.load_node(&current_root_hash).await?;
        let root_level = root_node.level();
        let mut key_was_actually_deleted = false;

        // Delegate to core_logic's recursive_delete_impl
        let result = self.recursive_delete_impl(current_root_hash, key, root_level, &mut key_was_actually_deleted).await?;
        
        match result {
            DeleteRecursionResult::NotFound { .. } => Ok(key_was_actually_deleted),
            DeleteRecursionResult::Updated(update_info) => {
                self.root_hash = Some(update_info.new_hash);
                // Check if root became an internal node with a single child, then collapse
                let potentially_new_root_node = self.load_node(&self.root_hash.unwrap()).await?;
                if let Node::Internal { ref children, .. } = potentially_new_root_node {
                    if children.len() == 1 {
                        self.root_hash = Some(children[0].child_hash);
                    }
                }
                Ok(key_was_actually_deleted)
            }
            DeleteRecursionResult::Merged => {
                self.root_hash = None; // Tree is now empty
                Ok(key_was_actually_deleted)
            }
        }
    }

    // Wrapper for core_logic's implementation
    fn recursive_delete_impl<'s>(
        &'s self, // Pass &self
        node_hash: Hash,
        key: &'s Key, // Key lifetime tied to 's
        level: u8,
        key_actually_deleted_flag: &'s mut bool, // Flag lifetime tied to 's
    ) -> Pin<Box<dyn Future<Output = Result<DeleteRecursionResult>> + Send + 's>>
    where S: 's {
        Box::pin(core_logic::delete_recursive_impl(self, node_hash, key, level, key_actually_deleted_flag))
    }

    pub async fn count_all_items(&self) -> Result<u64> {
        if self.root_hash.is_none() {
            return Ok(0);
        }
        let root_node_hash = self.root_hash.unwrap();
        let root_node = self.load_node(&root_node_hash).await?;

        match root_node {
            Node::Leaf { entries, .. } => Ok(entries.len() as u64),
            Node::Internal { children, .. } => {
                Ok(children.iter().map(|c| c.num_items_subtree).sum())
            }
        }
    }
    
    pub async fn commit(&mut self) -> Result<Option<Hash>> {
        Ok(self.root_hash)
    }

    pub async fn cursor_start(&self) -> Result<Cursor<S>> {
        Cursor::new_at_start(self).await
    }

    pub async fn seek(&self, key: &Key) -> Result<Cursor<S>> {
        Cursor::new_at_key(self, key).await
    }

    pub async fn diff(&self, other_root_hash: Option<Hash>) -> Result<Vec<DiffEntry>> {
        diff_trees(
            self.root_hash,
            other_root_hash,
            Arc::clone(&self.store),
            self.config.clone(),
        )
        .await
    }

    pub async fn gc(&self, app_provided_live_root_hashes: &[Hash]) -> Result<usize> {
        let collector = GarbageCollector::new(Arc::clone(&self.store));
        let mut all_live_roots_set = app_provided_live_root_hashes.iter().cloned().collect::<std::collections::HashSet<Hash>>();
        if let Some(current_root) = self.root_hash {
            all_live_roots_set.insert(current_root);
        }
        let all_live_roots_vec = all_live_roots_set.into_iter().collect::<Vec<Hash>>();
        collector.collect(&all_live_roots_vec).await
    }

    pub async fn scan(&self, args: ScanArgs) -> Result<ScanPage> {
        let mut collected_items: Vec<(Key, Value)> = Vec::new();
        let mut items_to_fetch: Option<usize> = None;
        let mut actual_next_item_for_cursor: Option<(Key, Value)> = None;

        if let Some(limit_val) = args.limit {
            if limit_val > 0 {
                items_to_fetch = Some(limit_val + 1);
            } else {
                items_to_fetch = Some(0);
            }
        }
      
        let mut cursor = Cursor::new_for_scan(self, &args).await?;
        let mut first_item_key: Option<Key> = None;
        // let mut last_item_key_in_page: Option<Key> = None; // Not strictly needed for ScanPage result

        if items_to_fetch != Some(0) {
            for _i in 0..items_to_fetch.unwrap_or(usize::MAX) {
                match cursor.next_in_scan(&args).await? {
                    Some((key, value)) => {
                        if first_item_key.is_none() {
                            first_item_key = Some(key.clone());
                        }

                        if items_to_fetch.is_some() && collected_items.len() < args.limit.unwrap_or(usize::MAX) {
                            // last_item_key_in_page = Some(key.clone());
                            collected_items.push((key, value));
                        } else if items_to_fetch.is_some() && collected_items.len() == args.limit.unwrap_or(usize::MAX) {
                            actual_next_item_for_cursor = Some((key, value));
                            break; 
                        } else if items_to_fetch.is_none() {
                            // last_item_key_in_page = Some(key.clone());
                            collected_items.push((key, value));
                        }
                    }
                    None => break, 
                }
            }
        }

        let final_has_next_page = actual_next_item_for_cursor.is_some();
        let calculated_has_previous_page = args.offset > 0 || (args.start_bound.is_some() && args.offset == 0) ;


        Ok(ScanPage {
            items: collected_items,
            has_next_page: final_has_next_page,
            has_previous_page: calculated_has_previous_page,
            next_page_cursor: actual_next_item_for_cursor.map(|(k, _v)| k),
            previous_page_cursor: first_item_key, // Or last_item_key_in_page if logic for prev cursor is different
        })
    }
}