// prolly-rust/src/node/mod.rs

pub mod definition;

// Re-export key items for easier access from `crate::node::`
pub use definition::{Node, LeafEntry, InternalEntry, ValueRepr};
// Potentially re-export constants like FANOUT if they remain in definition.rs
// pub use definition::DEFAULT_FANOUT; // Example if we make FANOUT part of TreeConfig or a default