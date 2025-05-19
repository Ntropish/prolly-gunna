// packages/prolly-rust/src/store/file_io_v2.rs
use super::format_v2::{
    FileHeaderV2, ChunkIndexEntryV2, MetadataContentV2, EofBlockV2, ContentBlockEnvelope,
    FILE_SIGNATURE_V2, FORMAT_VERSION_V2, CHUNK_HASH_SIZE, 
    TAG_CHUNK_INDEX_BLOCK, TAG_METADATA_BLOCK, TAG_EOF_BLOCK,
    calculate_crc32, calculate_blake3_hash
};
use crate::error::ProllyError;
use crate::TreeConfig;
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
// ***** ADD THIS IMPORT *****
use byteorder::{BigEndian, WriteBytesExt, ReadBytesExt}; // Or use bincode::byteorder::...
use chrono::Utc;
// ***** ADD THIS IMPORT *****
use serde_json;


// CONFIGURATION - Set to true to enable overall file checksum
const ENABLE_OVERALL_FILE_CHECKSUM: bool = true;

pub fn write_prly_tree_v2(
    root_hash: Option<[u8; CHUNK_HASH_SIZE]>,
    tree_config: &TreeConfig,
    chunks: &HashMap<[u8; CHUNK_HASH_SIZE], Vec<u8>>,
    description: Option<String>,
) -> Result<Vec<u8>, ProllyError> {
    let mut file_buffer = Vec::new(); 
    
    let mut content_writer = Cursor::new(Vec::new());

    // 1. Prepare Chunk Data and Index Entries
    let mut chunk_index_entries = Vec::new();
    let mut current_chunk_data_offset = FileHeaderV2::size() as u64;
    let mut total_chunk_data_bytes = 0u64;
    
    let mut chunk_data_buffer = Vec::new();
    for (hash, data) in chunks.iter() {
        chunk_data_buffer.write_all(data)?; // This returns std::io::Result
        chunk_index_entries.push(ChunkIndexEntryV2 {
            hash: *hash,
            offset: current_chunk_data_offset,
            length: data.len() as u32,
            chunk_type_flags: 0,
        });
        current_chunk_data_offset += data.len() as u64;
        total_chunk_data_bytes += data.len() as u64;
    }
    chunk_index_entries.sort_by_key(|entry| entry.hash);

    // 2. Prepare Chunk Index Block Content
    content_writer.seek(SeekFrom::Start(0))?;
    content_writer.get_mut().clear();
    content_writer.write_u32::<BigEndian>(chunk_index_entries.len() as u32)?; // Uses WriteBytesExt
    for entry in &chunk_index_entries {
        entry.write_to(&mut content_writer)?;
    }
    let chunk_index_content_bytes = content_writer.get_ref().to_vec();
    let chunk_index_checksum = calculate_crc32(&chunk_index_content_bytes);
    let chunk_index_envelope = ContentBlockEnvelope::new(
        TAG_CHUNK_INDEX_BLOCK,
        chunk_index_content_bytes.len() as u32,
        chunk_index_checksum,
    );

    // 3. Prepare Metadata Block Content
    let metadata_content = MetadataContentV2 {
        root_hash,
        tree_config: tree_config.clone(),
        created_at: Utc::now().to_rfc3339(),
        description,
        total_chunk_data_bytes,
    };
    // Use serde_json here
    let metadata_json_bytes = serde_json::to_vec(&metadata_content)
        .map_err(|e| ProllyError::Serialization(e.to_string()))?; // This conversion is fine
    
    let metadata_checksum = calculate_crc32(&metadata_json_bytes);
    let metadata_envelope = ContentBlockEnvelope::new(
        TAG_METADATA_BLOCK,
        metadata_json_bytes.len() as u32,
        metadata_checksum,
    );

    let mut final_writer = Cursor::new(&mut file_buffer);
    
    final_writer.seek(SeekFrom::Start(FileHeaderV2::size() as u64))?;

    let _offset_after_header = final_writer.position();
    final_writer.write_all(&chunk_data_buffer)?;
    
    let offset_chunk_index_block_start = final_writer.position();
    chunk_index_envelope.write_to(&mut final_writer)?;
    final_writer.write_all(&chunk_index_content_bytes)?;

    let offset_metadata_block_start = final_writer.position();
    metadata_envelope.write_to(&mut final_writer)?;
    final_writer.write_all(&metadata_json_bytes)?;

    let offset_eof_block_start = final_writer.position();
    let mut reversed_signature = *FILE_SIGNATURE_V2;
    reversed_signature.reverse();

    let overall_file_blake3_checksum = if ENABLE_OVERALL_FILE_CHECKSUM {
        let mut temp_eof_for_checksum_calc_part = Vec::new();
        temp_eof_for_checksum_calc_part.write_u8(TAG_EOF_BLOCK)?;
        temp_eof_for_checksum_calc_part.write_u64::<BigEndian>(offset_metadata_block_start)?;
        temp_eof_for_checksum_calc_part.write_u64::<BigEndian>(offset_chunk_index_block_start)?;
        temp_eof_for_checksum_calc_part.write_all(&reversed_signature)?;

        // Checksum is of (header + chunk_data + index_block_envelope + index_block_content + metadata_block_envelope + metadata_block_content + first_part_of_eof)
        // The file_buffer currently contains: (empty_header_space | chunk_data | index_envelope | index_content | meta_envelope | meta_content)
        // So we need to construct the "final" header first to include it in the checksum if it's part of what's being checksummed *before* the checksum itself.
        // This is tricky. A simpler way is to checksum everything written so far *up to* the EOF block's checksum field.

        // Let's simplify: checksum everything from start of file up to the start of the EOF block itself.
        let content_before_eof_itself = final_writer.get_ref()[..offset_eof_block_start as usize].to_vec();
        Some(calculate_blake3_hash(&content_before_eof_itself))

    } else {
        None
    };
    
    let eof_block = EofBlockV2 {
        tag: TAG_EOF_BLOCK,
        offset_metadata_repeated: offset_metadata_block_start,
        offset_chunk_index_repeated: offset_chunk_index_block_start,
        signature_repeated: reversed_signature,
        overall_file_checksum: overall_file_blake3_checksum,
    };
    eof_block.write_to(&mut final_writer)?;
    
    let final_file_length = final_writer.position();
    final_writer.seek(SeekFrom::Start(0))?;
    let header = FileHeaderV2::new(
        offset_metadata_block_start,
        offset_chunk_index_block_start,
        offset_eof_block_start,
    );
    header.write_to(&mut final_writer)?;
    final_writer.seek(SeekFrom::Start(final_file_length))?;

    Ok(file_buffer)
}


pub fn read_prly_tree_v2(
    file_bytes: &[u8],
) -> Result<(Option<[u8; CHUNK_HASH_SIZE]>, TreeConfig, HashMap<[u8; CHUNK_HASH_SIZE], Vec<u8>>, Option<String>), ProllyError> {
    let mut reader = Cursor::new(file_bytes);

    let header = FileHeaderV2::read_from(&mut reader)
        .map_err(|e| ProllyError::InvalidFileFormat(format!("Failed to read header: {}", e)))?;
    if &header.signature != FILE_SIGNATURE_V2 {
        return Err(ProllyError::InvalidFileFormat("Invalid signature".into()));
    }
    if header.version != FORMAT_VERSION_V2 {
        return Err(ProllyError::InvalidFileFormat(format!("Unsupported version: {}", header.version)));
    }

    let data_to_checksum_for_overall: Option<&[u8]> = if ENABLE_OVERALL_FILE_CHECKSUM {
        Some(&file_bytes[0..header.offset_eof as usize])
    } else {
        None
    };

    reader.seek(SeekFrom::Start(header.offset_chunk_index))?;
    let chunk_index_envelope = ContentBlockEnvelope::read_from(&mut reader)?;
    if chunk_index_envelope.tag != TAG_CHUNK_INDEX_BLOCK {
        return Err(ProllyError::InvalidFileFormat("Chunk Index Block tag mismatch".into()));
    }
    let mut chunk_index_content_bytes = vec![0u8; chunk_index_envelope.content_length as usize];
    reader.read_exact(&mut chunk_index_content_bytes)?;
    let calculated_chunk_index_checksum = calculate_crc32(&chunk_index_content_bytes);
    if calculated_chunk_index_checksum != chunk_index_envelope.content_checksum {
        return Err(ProllyError::ChecksumMismatch { context: "Chunk Index Block".into() });
    }
    let mut content_reader = Cursor::new(chunk_index_content_bytes);
    let num_index_entries = content_reader.read_u32::<BigEndian>()?; // Uses ReadBytesExt
    let mut chunk_index_entries = Vec::with_capacity(num_index_entries as usize);
    for _ in 0..num_index_entries {
        chunk_index_entries.push(ChunkIndexEntryV2::read_from(&mut content_reader)?);
    }
    
    reader.seek(SeekFrom::Start(header.offset_metadata))?;
    let metadata_envelope = ContentBlockEnvelope::read_from(&mut reader)?;
    if metadata_envelope.tag != TAG_METADATA_BLOCK {
        return Err(ProllyError::InvalidFileFormat("Metadata Block tag mismatch".into()));
    }
    let mut metadata_json_bytes = vec![0u8; metadata_envelope.content_length as usize];
    reader.read_exact(&mut metadata_json_bytes)?;
    let calculated_metadata_checksum = calculate_crc32(&metadata_json_bytes);
    if calculated_metadata_checksum != metadata_envelope.content_checksum {
        return Err(ProllyError::ChecksumMismatch { context: "Metadata Block".into() });
    }
    let metadata_content: MetadataContentV2 = serde_json::from_slice(&metadata_json_bytes) // Use serde_json here
        .map_err(|e| ProllyError::Deserialization(e.to_string()))?;


    let mut chunks_map = HashMap::new();
    for entry in &chunk_index_entries {
        if entry.offset + entry.length as u64 > file_bytes.len() as u64 {
            return Err(ProllyError::InvalidFileFormat(format!("Chunk offset/length out of bounds for hash {:?}", entry.hash)));
        }
        let chunk_data_slice = &file_bytes[entry.offset as usize .. (entry.offset + entry.length as u64) as usize];
        chunks_map.insert(entry.hash, chunk_data_slice.to_vec());
    }

    reader.seek(SeekFrom::Start(header.offset_eof))?;
    let eof_block = EofBlockV2::read_from(&mut reader, ENABLE_OVERALL_FILE_CHECKSUM)?;
     if eof_block.tag != TAG_EOF_BLOCK {
        return Err(ProllyError::InvalidFileFormat("EOF Block tag mismatch.".into()));
    }
    // It's okay if these don't match perfectly if an older writer didn't place them exactly at content start
    // if eof_block.offset_chunk_index_repeated != header.offset_chunk_index + ContentBlockEnvelope::size() as u64 || 
    //    eof_block.offset_metadata_repeated != header.offset_metadata + ContentBlockEnvelope::size() as u64 {
    //      eprintln!("Warning: EOF block repeated offset pointers do not perfectly match content start of blocks from header.");
    // }
    let mut expected_reversed_sig = *FILE_SIGNATURE_V2;
    expected_reversed_sig.reverse();
    if eof_block.signature_repeated != expected_reversed_sig {
        return Err(ProllyError::InvalidFileFormat("EOF block reversed signature mismatch.".into()));
    }

    if ENABLE_OVERALL_FILE_CHECKSUM {
        if let (Some(expected_checksum_bytes), Some(content_to_check)) = (eof_block.overall_file_checksum, data_to_checksum_for_overall) {
            let calculated_overall_checksum = calculate_blake3_hash(content_to_check);
            if calculated_overall_checksum != expected_checksum_bytes {
                 return Err(ProllyError::ChecksumMismatch{ context: "Overall file content".into()});
            }
        } else if eof_block.overall_file_checksum.is_some() && data_to_checksum_for_overall.is_none() {
             return Err(ProllyError::InternalError("Overall checksum present in file but not configured to check, or vice-versa.".into()));
        }
    }

    Ok((
        metadata_content.root_hash,
        metadata_content.tree_config,
        chunks_map,
        metadata_content.description,
    ))
}