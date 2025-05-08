// prolly-rust/src/store/chunk_store.rs

use async_trait::async_trait;
use crate::common::Hash;
use crate::error::Result; // Using our custom Result type

/// Trait for a content-addressable chunk store.
/// Implementations are responsible for storing and retrieving opaque byte chunks.
#[async_trait]
pub trait ChunkStore: Send + Sync + std::fmt::Debug + 'static {
    /// Retrieves a chunk by its hash.
    /// Returns `Ok(None)` if the chunk is not found.
    async fn get(&self, hash: &Hash) -> Result<Option<Vec<u8>>>;

    /// Stores a chunk and returns its hash.
    /// The store should ideally compute the hash internally using a consistent
    /// hashing algorithm (e.g., the one from `crate::chunk::hash_bytes`).
    /// If the chunk already exists, it may choose to do nothing and return the hash.
    async fn put(&self, bytes: Vec<u8>) -> Result<Hash>; // Takes ownership of bytes

    /// Checks if a chunk with the given hash exists in the store.
    /// Optional: can be defaulted if not implemented, or implemented for efficiency.
    async fn exists(&self, hash: &Hash) -> Result<bool> {
        self.get(hash).await.map(|opt| opt.is_some())
    }

    // Future considerations:
    // async fn delete(&self, hash: &Hash) -> Result<()>; // For garbage collection
    // async fn flush(&self) -> Result<()>; // If the store buffers writes
}