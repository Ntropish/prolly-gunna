//! Blake3 hashing + naïve chunker (one node == one chunk).
use blake3::Hasher;
use crate::node::Node;

pub type Hash = [u8; 32];

pub fn hash_bytes(bytes: &[u8]) -> Hash {
    Hasher::new().update(bytes).finalize().into()
}

pub fn chunk_node(node: &Node) -> (Hash, Vec<u8>) {
    let encoded = node.encode();
    (hash_bytes(&encoded), encoded)
}