// prolly-rust/src/store/chunk_store.rs

use async_trait::async_trait;
use crate::common::Hash;
use crate::error::Result; // Using our custom Result type

/// Trait for a content-addressable chunk store.
/// Implementations are responsible for storing and retrieving opaque byte chunks.
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait ChunkStore: std::fmt::Debug + 'static {
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
}