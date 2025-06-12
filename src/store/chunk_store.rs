// prolly-rust/src/store/chunk_store.rs

use async_trait::async_trait;
use crate::common::Hash;
use crate::error::{Result, ProllyError};

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

    /// Deletes a batch of chunks identified by their hashes.
    /// This is primarily intended for use by a garbage collection process.
    /// The method should succeed even if some of the provided hashes are not found.
    async fn delete_batch(&self, hashes: &[Hash]) -> Result<()>;

    /// Retrieves all unique chunk hashes currently present in the store.
    /// This is used by the garbage collector to know the entire set of potentially collectible chunks.
    /// Note: Depending on the store's size, this could return a large vector.
    /// For very large stores, an asynchronous iterator might be more memory-efficient,
    /// but Vec<Hash> is simpler for now.
    async fn all_hashes(&self) -> Result<Vec<Hash>>;

    /// Synchronously retrieves a chunk by its hash.
    /// This is a non-blocking operation that will fail if the underlying
    /// store cannot be accessed without blocking.
    /// Returns `Ok(None)` if the chunk is not found.
    fn get_sync(&self, _hash: &Hash) -> Result<Option<Vec<u8>>> {
        // Default implementation indicates that the operation is not supported.
        // Specific implementations must override this.
        Err(ProllyError::InvalidOperation(
            "This store does not support synchronous get.".to_string(),
        ))
    }

    fn put_sync(&self, _bytes: Vec<u8>) -> Result<Hash> {
        Err(ProllyError::InvalidOperation(
            "This store does not support synchronous put.".to_string(),
        ))
    }

    fn delete_batch_sync(&self, _hashes: &[Hash]) -> Result<()> {
        Err(ProllyError::InvalidOperation(
            "This store does not support synchronous delete_batch.".to_string(),
        ))
    }

    // Future considerations:
    // async fn delete(&self, hash: &Hash) -> Result<()>; // Old single delete, now covered by delete_batch
    // async fn flush(&self) -> Result<()>; // If the store buffers writes
}