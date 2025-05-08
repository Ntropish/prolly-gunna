// prolly-rust/src/tree/mod.rs

pub mod prolly_tree;
// pub mod cursor;      // Future: For tree traversal and range queries
// pub mod diff_new;    // Future: For the new diff algorithm implementation
// pub mod builder;     // Future: For efficient bulk loading of data

// Re-export the main ProllyTree struct for easier access
pub use prolly_tree::ProllyTree;