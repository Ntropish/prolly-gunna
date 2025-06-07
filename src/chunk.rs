// prolly-rust/src/chunk.rs

//! Blake3 hashing and node chunking utilities.
use blake3::Hasher;
use crate::common::Hash; // Use Hash from common module
use crate::node::definition::Node; // Use the new Node definition
use crate::error::Result; // Use our custom Result and Error

/// Computes a Blake3 hash for a slice of bytes.
pub fn hash_bytes(bytes: &[u8]) -> Hash {
    Hasher::new().update(bytes).finalize().into()
}

/// Encodes a node and computes its hash.
/// Currently implements a "one node == one chunk" strategy.
///
/// # Arguments
/// * `node` - A reference to the `Node` to be chunked.
///
/// # Returns
/// A `Result` containing a tuple of the `Hash` and the encoded `Vec<u8>` bytes of the node.
pub fn chunk_node(node: &Node) -> Result<(Hash, Vec<u8>)> {
    // Node::encode() now returns a Result<Vec<u8>, ProllyError>
    let encoded_bytes = node.encode()?; // Propagate error if encoding fails
    let hash = hash_bytes(&encoded_bytes);
    Ok((hash, encoded_bytes))
}

// Future: Placeholder for Content-Defined Chunker (CDC) logic
//
// pub trait ContentChunker {
//     fn chunk<'a>(&self, data: &'a [u8]) -> Box<dyn Iterator<Item = &'a [u8]> + 'a>;
// }
//
// pub struct FastCdcChunker {
//     min_size: usize,
//     avg_size: usize,
//     max_size: usize,
// }
//
// impl FastCdcChunker {
//     pub fn new(min_size: usize, avg_size: usize, max_size: usize) -> Self {
//         // Initialize fastcdc::FastCDC here if we were using it
//         Self { min_size, avg_size, max_size }
//     }
// }
//
// impl ContentChunker for FastCdcChunker {
//     fn chunk<'a>(&self, data: &'a [u8]) -> Box<dyn Iterator<Item = &'a [u8]> + 'a> {
//         // Example:
//         // let chunker = fastcdc::FastCDC::new(data, self.min_size, self.avg_size, self.max_size);
//         // Box::new(chunker.map(|entry| &data[entry.offset..entry.offset + entry.length]))
//         // This is highly simplified; actual implementation needs careful iterator handling.
//         unimplemented!("CDC chunker not yet implemented");
//     }
// }