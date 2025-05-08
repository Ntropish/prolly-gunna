// prolly-rust/src/store/mod.rs

pub mod chunk_store;
pub mod mem_store;
// pub mod file_store; // Future: Placeholder for a file-based store

// Re-export key items for easier access from `crate::store::`
pub use chunk_store::ChunkStore;
pub use mem_store::InMemoryStore;

