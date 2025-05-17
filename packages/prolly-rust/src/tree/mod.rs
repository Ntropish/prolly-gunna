
pub mod cursor;
pub mod prolly_tree; // This is our main facade

mod core_logic;     // Contains recursive tree traversal logic (get, insert, delete internals)
mod io;             // Contains node serialization/deserialization and value preparation
mod modification;   // Contains tree modification logic (balancing, merging)
mod types;          // Contains internal helper structs/enums and public API data structs

// Re-export public types from the tree module that users of `crate::tree::...` would need
pub use prolly_tree::ProllyTree;
pub use cursor::Cursor;
pub use types::{ScanArgs, ScanPage}; // Make ScanArgs/Page accessible via `crate::tree::ScanArgs`