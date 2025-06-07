// prolly-rust/src/node/definition.rs

use serde::{Serialize, Deserialize};
use crate::common::{Hash, Key, Value, TreeConfig}; // TreeConfig for FANOUT access
use crate::error::{Result, ProllyError};

/// Represents a value stored in a leaf node.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ValueRepr {
    /// Value is small enough to be stored directly within the node.
    Inline(Value),
    /// Value was large and resulted in exactly one data chunk. Stores the hash of that chunk.
    Chunked(Hash),
    /// Value was large and split into multiple data chunks by CDC. Stores the sequence of chunk hashes.
    ChunkedSequence {
        /// Hashes of the data chunks, in order.
        chunk_hashes: Vec<Hash>,
        /// The total original size of the data represented by the chunks. (Useful for pre-allocation on read)
        total_size: u64, 
    },
}

/// An entry in a leaf node, mapping a key to a value representation.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LeafEntry {
    pub key: Key,
    pub value: ValueRepr,
}

/// An entry in an internal node, pointing to a child node.
/// The `boundary_key` acts as a separator. All keys in the `child_node`
/// are less than or equal to this `boundary_key`.
/// The last child in an internal node might not need a boundary_key or use a conceptual max_key.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct InternalEntry {
    /// The key that delimits the upper bound of keys in the child_node.
    /// For the "leftmost" pointer in some B-tree variants, this might be omitted
    /// or handled specially, but Prolly Trees often have keys for all pointers.
    /// A common strategy: this key is the *largest key* in the subtree pointed to by `child_hash`.
    pub boundary_key: Key,
    pub child_hash: Hash,
    pub num_items_subtree: u64, 
    // pub total_size_subtree: u64, // Optional: for size-based balancing
}

/// Represents a node in the Prolly Tree.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// Leaf node containing key-value entries.
    Leaf {
        level: u8, // Should always be 0 for leaves
        entries: Vec<LeafEntry>,
    },
    /// Internal node containing entries that point to child nodes.
    Internal {
        level: u8, // Greater than 0 for internal nodes
        children: Vec<InternalEntry>,
    },
}

impl Node {
    /// Creates a new, empty leaf node.
    pub fn new_leaf() -> Self {
        Node::Leaf {
            level: 0,
            entries: Vec::new(),
        }
    }

    /// Creates a new internal node from a list of child entries.
    /// The level should be one greater than the level of its children.
    pub fn new_internal(children: Vec<InternalEntry>, level: u8) -> Result<Self> {
        if level == 0 {
            return Err(ProllyError::ConfigError("Internal node level cannot be 0".to_string()));
        }
        if children.is_empty() && level > 1 { // An empty root internal node (level 1) might be valid if tree becomes empty after root was internal
             // This case needs careful handling during tree operations, an internal node should generally not be empty unless it's a very specific root state.
        }
        Ok(Node::Internal { level, children })
    }

    pub fn level(&self) -> u8 {
        match self {
            Node::Leaf { level, .. } => *level,
            Node::Internal { level, .. } => *level,
        }
    }

    /// Checks if the node has reached its target capacity (fanout).
    pub fn is_full(&self, config: &TreeConfig) -> bool {
        match self {
            Node::Leaf { entries, .. } => entries.len() >= config.target_fanout,
            Node::Internal { children, .. } => children.len() >= config.target_fanout,
        }
    }

    /// Checks if the node is below its minimum capacity.
    pub fn is_underflow(&self, config: &TreeConfig) -> bool {
        // The root node (leaf or internal) can have fewer than min_fanout entries.
        // This check is typically for non-root nodes.
        match self {
            Node::Leaf { entries, .. } => entries.len() < config.min_fanout,
            Node::Internal { children, .. } => children.len() < config.min_fanout,
        }
    }

    /// Encodes the node into bytes using bincode.
    pub fn encode(&self) -> Result<Vec<u8>> {
        bincode::serialize(self).map_err(ProllyError::from)
    }

    /// Decodes a node from bytes using bincode.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        bincode::deserialize(bytes).map_err(ProllyError::from)
    }

    // Utility to get the number of entries/children
    pub fn num_entries(&self) -> usize {
        match self {
            Node::Leaf { entries, .. } => entries.len(),
            Node::Internal { children, .. } => children.len(),
        }
    }
}