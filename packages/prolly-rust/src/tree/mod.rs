// prolly-rust/src/tree/mod.rs

pub mod prolly_tree;
pub mod cursor;   
  
// pub mod builder;     // Future: For efficient bulk loading of data

// Re-export the main ProllyTree struct for easier access
pub use prolly_tree::{ProllyTree, ScanArgs};
pub use cursor::Cursor;