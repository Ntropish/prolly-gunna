// prolly-rust/src/error.rs

use crate::common::Hash;
use thiserror::Error;

/// Custom error type for the Prolly Tree library.
#[derive(Error, Debug)]
pub enum ProllyError {
    #[error("Chunk not found in store for hash: {0:?}")]
    ChunkNotFound(Hash),

    #[error("Failed to deserialize node: {0}")]
    NodeDeserialization(String), // Or bincode::Error if we want to be specific

    #[error("Failed to serialize node: {0}")]
    NodeSerialization(String), // Or bincode::Error

    #[error("Storage operation failed: {0}")]
    StorageError(String), // Generic storage error

    #[error("I/O error: {source}")]
    IoError {
        #[from]
        source: std::io::Error,
    },

    #[error("Bincode serialization/deserialization error: {source}")]
    BincodeError {
        #[from]
        source: bincode::Error,
    },
    
    #[error("Attempted to operate on an empty tree where not allowed")]
    EmptyTree,

    #[error("Key not found in tree")]
    KeyNotFound,

    #[error("Invalid root hash provided")]
    InvalidRootHash,

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Internal error: {0}")]
    InternalError(String), // For unexpected logical errors

    // Add more specific error types as needed
}

/// Result type alias for Prolly Tree operations.
pub type Result<T> = std::result::Result<T, ProllyError>;

// Example of how you might convert a bincode error if not using #[from] directly everywhere
// impl From<bincode::Error> for ProllyError {
//     fn from(err: bincode::Error) -> Self {
//         ProllyError::NodeSerialization(err.to_string()) // Or a more specific variant
//     }
// }