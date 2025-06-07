
pub mod cursor;
pub mod prolly_tree; // This is our main facade
pub mod types;          // Contains internal helper structs/enums and public API data structs
pub mod hierarchy_cursor;

mod core_logic;     // Contains recursive tree traversal logic (get, insert, delete internals)
mod io;             // Contains node serialization/deserialization and value preparation
mod modification;   // Contains tree modification logic (balancing, merging)

// Re-export public types from the tree module that users of `crate::tree::...` would need
pub use prolly_tree::ProllyTree;
pub use cursor::Cursor;
pub use hierarchy_cursor::HierarchyCursor;
pub use types::{ScanArgs, ScanPage, HierarchyScanArgs, HierarchyItem, HierarchyScanPage}; // Make ScanArgs/Page accessible via `crate::tree::ScanArgs`