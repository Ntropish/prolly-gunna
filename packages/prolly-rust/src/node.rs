//! Binary representation helpers.
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LeafEntry { pub key: Vec<u8>, pub value: Vec<u8>, }

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum Node {
    Leaf { entries: Vec<LeafEntry> },
    Internal { children: Vec<()> }, // placeholder
}

impl Node {
    pub fn empty_leaf() -> Self { Node::Leaf { entries: Vec::new() } }

    pub fn encode(&self) -> Vec<u8> { bincode::serialize(self).expect("encode") }
    pub fn decode(bytes: &[u8]) -> Self { bincode::deserialize(bytes).expect("decode") }
}