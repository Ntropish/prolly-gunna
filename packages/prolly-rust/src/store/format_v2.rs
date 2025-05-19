// packages/prolly-rust/src/store/format_v2.rs

use crate::TreeConfig;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};

// --- Constants ---
pub const FILE_SIGNATURE_V2: &[u8; 8] = b"PRLYTRV2";
pub const FORMAT_VERSION_V2: u8 = 0x02;

pub const TAG_CHUNK_INDEX_BLOCK: u8 = 0x20;
pub const TAG_METADATA_BLOCK: u8 = 0x01;
pub const TAG_EOF_BLOCK: u8 = 0xFF;

pub const CHUNK_HASH_SIZE: usize = 32; // Typically for SHA-256 or Blake3
pub const CRC32_CHECKSUM_SIZE: usize = 4;
pub const BLAKE3_CHECKSUM_SIZE: usize = 32;


// --- Structures ---

#[derive(Debug, Clone, PartialEq)]
pub struct FileHeaderV2 {
    pub signature: [u8; 8],
    pub version: u8,
    pub header_flags: u8,
    pub offset_metadata: u64,
    pub offset_chunk_index: u64,
    pub offset_eof: u64,
    pub reserved: [u8; 8],
}

impl FileHeaderV2 {
    pub fn new(offset_metadata: u64, offset_chunk_index: u64, offset_eof: u64) -> Self {
        Self {
            signature: *FILE_SIGNATURE_V2,
            version: FORMAT_VERSION_V2,
            header_flags: 0,
            offset_metadata,
            offset_chunk_index,
            offset_eof,
            reserved: [0; 8],
        }
    }

    pub fn write_to<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(&self.signature)?;
        writer.write_u8(self.version)?;
        writer.write_u8(self.header_flags)?;
        writer.write_u64::<BigEndian>(self.offset_metadata)?;
        writer.write_u64::<BigEndian>(self.offset_chunk_index)?;
        writer.write_u64::<BigEndian>(self.offset_eof)?;
        writer.write_all(&self.reserved)?;
        Ok(())
    }

    pub fn read_from<R: Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut signature = [0u8; 8];
        reader.read_exact(&mut signature)?;
        let version = reader.read_u8()?;
        let header_flags = reader.read_u8()?;
        let offset_metadata = reader.read_u64::<BigEndian>()?;
        let offset_chunk_index = reader.read_u64::<BigEndian>()?;
        let offset_eof = reader.read_u64::<BigEndian>()?;
        let mut reserved = [0u8; 8];
        reader.read_exact(&mut reserved)?;

        Ok(Self {
            signature,
            version,
            header_flags,
            offset_metadata,
            offset_chunk_index,
            offset_eof,
            reserved,
        })
    }

    pub fn size() -> usize {
        8 + 1 + 1 + 8 + 8 + 8 + 8
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)] // Added Ord for sorting
pub struct ChunkIndexEntryV2 {
    pub hash: [u8; CHUNK_HASH_SIZE],
    pub offset: u64,
    pub length: u32,
    pub chunk_type_flags: u8,
}

impl ChunkIndexEntryV2 {
    pub fn write_to<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(&self.hash)?;
        writer.write_u64::<BigEndian>(self.offset)?;
        writer.write_u32::<BigEndian>(self.length)?;
        writer.write_u8(self.chunk_type_flags)?;
        Ok(())
    }

    pub fn read_from<R: Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut hash = [0u8; CHUNK_HASH_SIZE];
        reader.read_exact(&mut hash)?;
        let offset = reader.read_u64::<BigEndian>()?;
        let length = reader.read_u32::<BigEndian>()?;
        let chunk_type_flags = reader.read_u8()?;
        Ok(Self {
            hash,
            offset,
            length,
            chunk_type_flags,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MetadataContentV2 {
    pub root_hash: Option<[u8; CHUNK_HASH_SIZE]>,
    pub tree_config: TreeConfig,
    pub created_at: String,
    pub description: Option<String>,
    pub total_chunk_data_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EofBlockV2 {
    pub tag: u8,
    pub offset_metadata_repeated: u64,
    pub offset_chunk_index_repeated: u64,
    pub signature_repeated: [u8; 8],
    pub overall_file_checksum: Option<[u8; BLAKE3_CHECKSUM_SIZE]>,
}

impl EofBlockV2 {
    pub fn write_to<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_u8(self.tag)?;
        writer.write_u64::<BigEndian>(self.offset_metadata_repeated)?;
        writer.write_u64::<BigEndian>(self.offset_chunk_index_repeated)?;
        writer.write_all(&self.signature_repeated)?;
        match &self.overall_file_checksum {
            Some(checksum) => writer.write_all(checksum)?,
            None => {
                 // If no checksum, write zero bytes to maintain fixed size if desired
                 // For now, if None, nothing extra is written beyond this.
                 // Alternatively, a fixed size (e.g. 32 zero bytes) could be written.
            }
        }
        Ok(())
    }

    pub fn read_from<R: Read>(reader: &mut R, has_overall_checksum: bool) -> std::io::Result<Self> {
        let tag = reader.read_u8()?;
        let offset_metadata_repeated = reader.read_u64::<BigEndian>()?;
        let offset_chunk_index_repeated = reader.read_u64::<BigEndian>()?;
        let mut signature_repeated = [0u8; 8];
        reader.read_exact(&mut signature_repeated)?;
        
        let overall_file_checksum = if has_overall_checksum {
            let mut checksum_bytes = [0u8; BLAKE3_CHECKSUM_SIZE];
            reader.read_exact(&mut checksum_bytes)?;
            Some(checksum_bytes)
        } else {
            None
        };

        Ok(Self {
            tag,
            offset_metadata_repeated,
            offset_chunk_index_repeated,
            signature_repeated,
            overall_file_checksum,
        })
    }
}

// Header for a content block (e.g., Metadata, Chunk Index) that includes a checksum.
pub struct ContentBlockEnvelope {
    pub tag: u8,
    pub content_length: u32, // Length of the actual content, excluding this header and checksum
    pub content_checksum: u32, // CRC32 of the content
}

impl ContentBlockEnvelope {
    pub fn new(tag: u8, content_length: u32, content_checksum: u32) -> Self {
        Self { tag, content_length, content_checksum }
    }

    pub fn write_to<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_u8(self.tag)?;
        writer.write_u32::<BigEndian>(self.content_length)?;
        writer.write_u32::<BigEndian>(self.content_checksum)?; // CRC32 checksum
        Ok(())
    }

    pub fn read_from<R: Read>(reader: &mut R) -> std::io::Result<Self> {
        let tag = reader.read_u8()?;
        let content_length = reader.read_u32::<BigEndian>()?;
        let content_checksum = reader.read_u32::<BigEndian>()?;
        Ok(Self { tag, content_length, content_checksum })
    }

    pub fn size() -> usize {
        1 + 4 + 4 // tag + length + checksum
    }
}

// Utility for checksums
pub fn calculate_crc32(data: &[u8]) -> u32 {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(data);
    hasher.finalize()
}

pub fn calculate_blake3_hash(data: &[u8]) -> [u8; BLAKE3_CHECKSUM_SIZE] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(data);
    *hasher.finalize().as_bytes()
}