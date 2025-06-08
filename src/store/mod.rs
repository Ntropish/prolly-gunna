// prolly-rust/src/store/mod.rs

pub mod chunk_store;
pub mod mem_store;
pub mod format_v2; 
pub mod file_io_v2; 

// Add the new module
#[cfg(target_arch = "wasm32")]
pub mod indexed_db_store;

// Re-export key items for easier access from `crate::store::`
pub use chunk_store::ChunkStore;
pub use mem_store::InMemoryStore;

// Add the new store to the re-exports
#[cfg(target_arch = "wasm32")]
pub use indexed_db_store::IndexedDBStore;