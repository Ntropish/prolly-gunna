use crate::store::ChunkStore;
use std::future::Future;
use std::pin::Pin;

// On native (non-wasm) targets, a store used by the tree must be thread-safe.
#[cfg(not(target_arch = "wasm32"))]
pub trait PlatformStore: ChunkStore + Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: ChunkStore + Send + Sync> PlatformStore for T {}

// On wasm, this requirement is relaxed as it's single-threaded.
#[cfg(target_arch = "wasm32")]
pub trait PlatformStore: ChunkStore {}
#[cfg(target_arch = "wasm32")]
impl<T: ChunkStore> PlatformStore for T {}

// Define a future type that is `Send` on native but not on wasm.
#[cfg(not(target_arch = "wasm32"))]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[cfg(target_arch = "wasm32")]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;