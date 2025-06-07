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
use byteorder::{BigEndian, WriteBytesExt, ReadBytesExt}; // Ensure ReadBytesExt is here if needed elsewhere, though not directly in this func
use chrono::Utc;
use serde_json;


// CONFIGURATION - Set to true to enable overall file checksum
const ENABLE_OVERALL_FILE_CHECKSUM: bool = true;

pub fn write_prly_tree_v2(
    root_hash: Option<[u8; CHUNK_HASH_SIZE]>,
    tree_config: &TreeConfig,
    chunks: &HashMap<[u8; CHUNK_HASH_SIZE], Vec<u8>>,
    description: Option<String>,
) -> Result<Vec<u8>, ProllyError> {
    // This buffer will become the final file content.
    // Initialize with space for the header.
    let mut file_buffer = vec![0u8; FileHeaderV2::size()];

    // These offsets will be determined and needed later for the EOF block and checksum.
    let offset_chunk_index_block_envelope_start: u64;
    let offset_metadata_block_envelope_start: u64;
    let offset_eof_block_begins: u64;

    // --- Scope for the main content and header writing ---
    // This ensures buffer_writer's mutable borrow of file_buffer is released
    // before file_buffer is immutably borrowed for checksum calculation.
    {
        let mut buffer_writer = Cursor::new(&mut file_buffer);
        // Move cursor past the initial header space.
        buffer_writer.seek(SeekFrom::Start(FileHeaderV2::size() as u64))?;

        // 1. Prepare and Write Chunk Data
        let mut chunk_index_entries = Vec::new();
        let mut current_chunk_data_offset = FileHeaderV2::size() as u64;
        let mut total_chunk_data_bytes = 0u64;
        let mut chunk_data_to_write = Vec::new(); // Temp buffer for all chunk data

        for (hash, data) in chunks.iter() {
            chunk_data_to_write.write_all(data)?;
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
        buffer_writer.write_all(&chunk_data_to_write)?; // Write all chunk data to file_buffer

        // 2. Prepare and Write Chunk Index Block
        let mut temp_idx_content_writer = Cursor::new(Vec::new());
        temp_idx_content_writer.write_u32::<BigEndian>(chunk_index_entries.len() as u32)?;
        for entry in &chunk_index_entries {
            entry.write_to(&mut temp_idx_content_writer)?;
        }
        let chunk_index_content_bytes = temp_idx_content_writer.into_inner();
        let chunk_idx_checksum = calculate_crc32(&chunk_index_content_bytes);
        let chunk_index_envelope = ContentBlockEnvelope::new(
            TAG_CHUNK_INDEX_BLOCK,
            chunk_index_content_bytes.len() as u32,
            chunk_idx_checksum,
        );
        offset_chunk_index_block_envelope_start = buffer_writer.position();
        chunk_index_envelope.write_to(&mut buffer_writer)?;
        buffer_writer.write_all(&chunk_index_content_bytes)?;

        // 3. Prepare and Write Metadata Block
        let metadata_content = MetadataContentV2 {
            root_hash,
            tree_config: tree_config.clone(),
            created_at: Utc::now().to_rfc3339(),
            description,
            total_chunk_data_bytes,
        };
        let metadata_json_bytes = serde_json::to_vec(&metadata_content)
            .map_err(|e| ProllyError::Serialization(e.to_string()))?;
        let metadata_checksum = calculate_crc32(&metadata_json_bytes);
        let metadata_envelope = ContentBlockEnvelope::new(
            TAG_METADATA_BLOCK,
            metadata_json_bytes.len() as u32,
            metadata_checksum,
        );
        offset_metadata_block_envelope_start = buffer_writer.position();
        metadata_envelope.write_to(&mut buffer_writer)?;
        buffer_writer.write_all(&metadata_json_bytes)?;

        // Current position is where the EOF block will start.
        offset_eof_block_begins = buffer_writer.position();

        // 4. Write the Finalized Header into the beginning of file_buffer
        let final_header = FileHeaderV2::new(
            offset_metadata_block_envelope_start,
            offset_chunk_index_block_envelope_start,
            offset_eof_block_begins,
        );
        let original_cursor_pos = buffer_writer.position(); // Should be offset_eof_block_begins
        buffer_writer.seek(SeekFrom::Start(0))?;
        final_header.write_to(&mut buffer_writer)?;
        // Restore cursor to where EOF block will be written. This is important if buffer_writer were used further.
        // However, its primary purpose for arranging pre-EOF content is done.
        buffer_writer.seek(SeekFrom::Start(original_cursor_pos))?;

    } // `buffer_writer` goes out of scope here, releasing its mutable borrow on `file_buffer`.

    // `file_buffer` now contains: [Finalized Header | Chunk Data | Chunk Index Block | Metadata Block]
    // It is safe to immutably borrow `file_buffer` now.

    // 5. Calculate Overall File Checksum
    let overall_file_blake3_checksum_opt = if ENABLE_OVERALL_FILE_CHECKSUM {
        // The checksum is on all content from the start of the file up to where the EOF block begins.
        // `offset_eof_block_begins` marks this point.
        let content_to_checksum = &file_buffer[0..offset_eof_block_begins as usize];
        Some(calculate_blake3_hash(content_to_checksum))
    } else {
        None
    };

    // 6. Prepare EOF Block
    let mut reversed_signature = *FILE_SIGNATURE_V2;
    reversed_signature.reverse();
    let eof_block = EofBlockV2 {
        tag: TAG_EOF_BLOCK,
        offset_metadata_repeated: offset_metadata_block_envelope_start,
        offset_chunk_index_repeated: offset_chunk_index_block_envelope_start,
        signature_repeated: reversed_signature,
        overall_file_checksum: overall_file_blake3_checksum_opt,
    };

    // Append EOF block to file_buffer.
    // We can use a new Cursor or directly extend if FileHeaderV2::write_to allows it.
    // Using a new Cursor is cleaner and mirrors the earlier pattern.
    // Note: file_buffer's current length should be offset_eof_block_begins.
    // If writes inside the scope extended file_buffer beyond offset_eof_block_begins (e.g. due to header write logic),
    // ensure file_buffer is truncated or handled correctly if needed before appending EOF,
    // but Cursor writing into &mut Vec extends it, so file_buffer's length IS offset_eof_block_begins
    // after the scoped writes if buffer_writer was at that position when scope ended.
    // The header write was within the initial FileHeaderV2::size() portion.
    
    // The actual length of file_buffer should be offset_eof_block_begins at this point.
    // The EOF block should be appended.
    let mut eof_writer = Cursor::new(&mut file_buffer); // Re-borrow mutably, which is fine now.
    eof_writer.seek(SeekFrom::Start(offset_eof_block_begins))?; // Seek to where EOF should start
    eof_block.write_to(&mut eof_writer)?; // This will extend file_buffer
    
    Ok(file_buffer)
}

// No changes needed for read_prly_tree_v2 for this specific issue,
// as its checksum verification logic was likely correct, assuming the
// written file was correct.
pub fn read_prly_tree_v2(
    file_bytes: &[u8],
) -> Result<(Option<[u8; CHUNK_HASH_SIZE]>, TreeConfig, HashMap<[u8; CHUNK_HASH_SIZE], Vec<u8>>, Option<String>), ProllyError> {
    // ... (existing read logic remains the same) ...
    let mut reader = Cursor::new(file_bytes);

    let header = FileHeaderV2::read_from(&mut reader)
        .map_err(|e| ProllyError::InvalidFileFormat(format!("Failed to read header: {}", e)))?;
    if &header.signature != FILE_SIGNATURE_V2 {
        return Err(ProllyError::InvalidFileFormat("Invalid signature".into()));
    }
    if header.version != FORMAT_VERSION_V2 {
        return Err(ProllyError::InvalidFileFormat(format!("Unsupported version: {}", header.version)));
    }

    // This part in read_prly_tree_v2 should now match what write_prly_tree_v2 checksummed
    let data_to_checksum_for_overall: Option<&[u8]> = if ENABLE_OVERALL_FILE_CHECKSUM {
        if header.offset_eof as usize > file_bytes.len() {
            return Err(ProllyError::InvalidFileFormat("EOF offset in header is out of bounds.".into()));
        }
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
    let num_index_entries = content_reader.read_u32::<BigEndian>()?;
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
    let metadata_content: MetadataContentV2 = serde_json::from_slice(&metadata_json_bytes)
        .map_err(|e| ProllyError::Deserialization(e.to_string()))?;


    let mut chunks_map = HashMap::new();
    for entry in &chunk_index_entries {
        if entry.offset as u64 + entry.length as u64 > file_bytes.len() as u64 {
             return Err(ProllyError::InvalidFileFormat(format!("Chunk offset/length out of bounds for hash {:?}", entry.hash)));
        }
        // Ensure that the entry.offset itself is within bounds
        if entry.offset as usize >= file_bytes.len() && entry.length > 0 {
             return Err(ProllyError::InvalidFileFormat(format!("Chunk offset out of bounds for hash {:?}", entry.hash)));
        }
        // Ensure that slicing does not panic if entry.length is 0 but offset is at file_bytes.len()
        let end_offset = (entry.offset as u64 + entry.length as u64) as usize;
        if end_offset > file_bytes.len() {
             return Err(ProllyError::InvalidFileFormat(format!("Chunk end offset out of bounds for hash {:?}", entry.hash)));
        }
        let chunk_data_slice = &file_bytes[entry.offset as usize .. end_offset];
        chunks_map.insert(entry.hash, chunk_data_slice.to_vec());
    }

    reader.seek(SeekFrom::Start(header.offset_eof))?;
    let eof_block = EofBlockV2::read_from(&mut reader, ENABLE_OVERALL_FILE_CHECKSUM)?;
     if eof_block.tag != TAG_EOF_BLOCK {
        return Err(ProllyError::InvalidFileFormat("EOF Block tag mismatch.".into()));
    }

    let mut expected_reversed_sig = *FILE_SIGNATURE_V2;
    expected_reversed_sig.reverse();
    if eof_block.signature_repeated != expected_reversed_sig {
        return Err(ProllyError::InvalidFileFormat("EOF block reversed signature mismatch.".into()));
    }

    if ENABLE_OVERALL_FILE_CHECKSUM {
        if let (Some(expected_checksum_bytes), Some(content_to_check)) = (eof_block.overall_file_checksum, data_to_checksum_for_overall) {
            let calculated_overall_checksum = calculate_blake3_hash(content_to_check);
            if calculated_overall_checksum != expected_checksum_bytes {
                 // For debugging, you could print the hex of both checksums here:
                 // eprintln!("Expected checksum: {:?}", hex::encode(expected_checksum_bytes));
                 // eprintln!("Calculated checksum: {:?}", hex::encode(calculated_overall_checksum));
                 // eprintln!("Content length checksummed: {}", content_to_check.len());
                 return Err(ProllyError::ChecksumMismatch{ context: "Overall file content".into()});
            }
        } else if eof_block.overall_file_checksum.is_some() && data_to_checksum_for_overall.is_none() {
            // This case means checksum is in file, but reading is not configured to check it (or vice-versa).
            // Should only happen if ENABLE_OVERALL_FILE_CHECKSUM differs between write and read, or file is corrupt.
             return Err(ProllyError::InternalError("Mismatch in overall file checksum presence vs. expectation.".into()));
        } else if eof_block.overall_file_checksum.is_none() && data_to_checksum_for_overall.is_some() {
            // If file was written without checksum, but reader expects it.
            // This might be okay if we allow loading older files that didn't have this checksum.
            // For now, strict checking:
            return Err(ProllyError::ChecksumMismatch{ context: "Overall file content checksum missing in file but expected".into()});
        }
        // If both are None (checksum disabled on write, and reader also has it disabled or file reflects it), it's fine.
    }


    Ok((
        metadata_content.root_hash,
        metadata_content.tree_config,
        chunks_map,
        metadata_content.description,
    ))
}