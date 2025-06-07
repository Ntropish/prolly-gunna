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

    #[error("JavaScript binding error: {0}")]
    JsBindingError(String),

    #[error("Invalid file format: {0}")]
    InvalidFileFormat(String),
    #[error("Checksum mismatch: {context}")]
    ChecksumMismatch { context: String },
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("Deserialization error: {0}")]
    Deserialization(String),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Wasm/JS interop error: {0}")]
    WasmInteropError(String),

    #[error("Invalid operation: {0}")]
    InvalidOperation(String),
    // Add more specific error types as needed

    
}

/// Result type alias for Prolly Tree operations.
pub type Result<T> = std::result::Result<T, ProllyError>;

// Helper for converting JsValue errors from wasm-bindgen
#[cfg(target_arch = "wasm32")]
impl From<wasm_bindgen::JsValue> for ProllyError {
    fn from(value: wasm_bindgen::JsValue) -> Self {
        ProllyError::WasmInteropError(format!("{:?}", value))
    }
}