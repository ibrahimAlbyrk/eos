// The app the installer carries: Forge's zip of the packaged Eos, appended to
// this exe (scripts/build-installer.mjs) and found through a 24-byte footer:
// MAGIC, then the zip's offset and length as little-endian u64s. The
// uninstaller is the same exe without them.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const MAGIC: &[u8; 8] = b"EOSPAYLD";
const FOOTER: u64 = 24;

pub struct Payload {
    pub offset: u64,
    pub len: u64,
}

/// The payload in `exe`, or None when this exe carries none (the uninstaller).
pub fn find(exe: &Path) -> io::Result<Option<Payload>> {
    let mut f = File::open(exe)?;
    let size = f.metadata()?.len();
    if size < FOOTER {
        return Ok(None);
    }
    f.seek(SeekFrom::End(-(FOOTER as i64)))?;
    let mut footer = [0u8; FOOTER as usize];
    f.read_exact(&mut footer)?;
    if &footer[..8] != MAGIC {
        return Ok(None);
    }
    let offset = u64::from_le_bytes(footer[8..16].try_into().unwrap());
    let len = u64::from_le_bytes(footer[16..24].try_into().unwrap());
    if offset.checked_add(len).map_or(true, |end| end > size - FOOTER) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "the installer's payload is damaged — download Eos again"));
    }
    Ok(Some(Payload { offset, len }))
}

/// A window onto `len` bytes of a file from `offset`: what the zip reader sees.
pub struct Slice {
    file: File,
    offset: u64,
    len: u64,
    pos: u64,
}

impl Slice {
    pub fn open(exe: &Path, p: &Payload) -> io::Result<Self> {
        let mut file = File::open(exe)?;
        file.seek(SeekFrom::Start(p.offset))?;
        Ok(Slice { file, offset: p.offset, len: p.len, pos: 0 })
    }
}

impl Read for Slice {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.len - self.pos;
        if left == 0 {
            return Ok(0);
        }
        let n = buf.len().min(left as usize);
        let read = self.file.read(&mut buf[..n])?;
        self.pos += read as u64;
        Ok(read)
    }
}

impl Seek for Slice {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if target < 0 || target as u64 > self.len {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek outside the payload"));
        }
        self.pos = target as u64;
        self.file.seek(SeekFrom::Start(self.offset + self.pos))?;
        Ok(self.pos)
    }
}
