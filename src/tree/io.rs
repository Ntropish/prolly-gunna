use std::sync::Arc;
use log::warn;
use fastcdc::v2020::FastCDC;

use crate::common::{Hash, Key, Value, TreeConfig};
use crate::error::{Result, ProllyError};
use crate::node::definition::{Node, ValueRepr};
use crate::store::ChunkStore;
use crate::chunk::{chunk_node, hash_bytes};

pub(super) async fn store_node_and_get_key_hash_pair<S: ChunkStore>(
    store: &Arc<S>,
    node: &Node,
) -> Result<(Key, Hash)> {
    let (hash, bytes) = chunk_node(node)?;
    store.put(bytes).await?;

    let boundary_key = match node {
        Node::Leaf { entries, .. } if !entries.is_empty() => Ok(entries.last().unwrap().key.clone()),
        Node::Internal { children, .. } if !children.is_empty() => Ok(children.last().unwrap().boundary_key.clone()),
        _ => Err(ProllyError::InternalError(
            "Attempted to get boundary key from empty or invalid node".to_string(),
        )),
    };
    Ok((boundary_key?, hash))
}

pub(super) fn store_node_and_get_key_hash_pair_sync<S: ChunkStore>(
    store: &Arc<S>,
    node: &Node,
) -> Result<(Key, Hash)> {
    let (hash, bytes) = chunk_node(node)?;
    store.put_sync(bytes)?;
    let boundary_key = match node {
        Node::Leaf { entries, .. } if !entries.is_empty() => Ok(entries.last().unwrap().key.clone()),
        Node::Internal { children, .. } if !children.is_empty() => Ok(children.last().unwrap().boundary_key.clone()),
        _ => Err(ProllyError::InternalError(
            "Attempted to get boundary key from empty or invalid node".to_string(),
        )),
    };
    Ok((boundary_key?, hash))
}

pub(super) async fn prepare_value_repr<S: ChunkStore>(
    store: &Arc<S>,
    config: &TreeConfig,
    value: Value,
) -> Result<ValueRepr> {
    if value.len() <= config.max_inline_value_size {
        return Ok(ValueRepr::Inline(value));
    }

    let chunker = FastCDC::new(
        &value,
        config.cdc_min_size as u32,
        config.cdc_avg_size as u32,
        config.cdc_max_size as u32,
    );

    let mut chunk_hashes = Vec::new();
    let total_size = value.len() as u64;

    for entry in chunker {
        let chunk_data = &value[entry.offset..entry.offset + entry.length];
        let chunk_hash = hash_bytes(chunk_data);
        store.put(chunk_data.to_vec()).await?;
        chunk_hashes.push(chunk_hash);
    }

    match chunk_hashes.len() {
        0 => {
            warn!("CDC produced 0 chunks for value of size {}. Storing inline.", value.len());
            Ok(ValueRepr::Inline(value))
        }
        1 => Ok(ValueRepr::Chunked(chunk_hashes[0])),
        _ => Ok(ValueRepr::ChunkedSequence {
            chunk_hashes,
            total_size,
        }),
    }
}

pub(super) fn prepare_value_repr_sync<S: ChunkStore>(
    store: &Arc<S>,
    config: &TreeConfig,
    value: Value,
) -> Result<ValueRepr> {
    if value.len() <= config.max_inline_value_size {
        return Ok(ValueRepr::Inline(value));
    }
    let chunker = FastCDC::new(
        &value,
        config.cdc_min_size as u32,
        config.cdc_avg_size as u32,
        config.cdc_max_size as u32,
    );
    let mut chunk_hashes = Vec::new();
    let total_size = value.len() as u64;
    for entry in chunker {
        let chunk_data = &value[entry.offset..entry.offset + entry.length];
        let chunk_hash = hash_bytes(chunk_data);
        store.put_sync(chunk_data.to_vec())?;
        chunk_hashes.push(chunk_hash);
    }
    match chunk_hashes.len() {
        0 => {
            warn!("CDC produced 0 chunks for value of size {}. Storing inline.", value.len());
            Ok(ValueRepr::Inline(value))
        }
        1 => Ok(ValueRepr::Chunked(chunk_hashes[0])),
        _ => Ok(ValueRepr::ChunkedSequence {
            chunk_hashes,
            total_size,
        }),
    }
}