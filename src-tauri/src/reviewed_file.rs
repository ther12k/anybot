use std::fs::{self, File, Metadata, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::commands::fs::is_protected_file;
use crate::workspace::{MAX_TEXT_BYTES, MAX_TEXT_MIB};

// Serialize AnyBot's final check and publication, not staging. External
// editors do not take this lock. Replacing an existing file is not a CAS.
static WRITE_COMMIT: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}

impl FileIdentity {
    fn of(meta: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            #[cfg(unix)]
            device: meta.dev(),
            #[cfg(unix)]
            inode: meta.ino(),
            #[cfg(not(unix))]
            created: meta.created().ok(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    identity: FileIdentity,
    modified: Option<SystemTime>,
    len: u64,
    permissions: Permissions,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(unix)]
    owner: (u32, u32),
}

impl FileStamp {
    fn of(meta: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            identity: FileIdentity::of(meta),
            modified: meta.modified().ok(),
            len: meta.len(),
            permissions: meta.permissions(),
            #[cfg(unix)]
            changed: (meta.ctime(), meta.ctime_nsec()),
            #[cfg(unix)]
            owner: (meta.uid(), meta.gid()),
        }
    }
}

#[derive(Debug, Clone)]
struct FileVersion {
    stamp: FileStamp,
    digest: [u8; 32],
}

#[derive(Debug, Clone)]
pub(crate) struct ReviewedFile {
    target: PathBuf,
    parent: FileIdentity,
    original: Option<FileVersion>,
}

impl ReviewedFile {
    pub(crate) fn inspect(requested: &Path) -> Result<(Self, String), String> {
        Self::inspect_inner(requested, |_| Ok(()), false)
    }

    pub(crate) fn inspect_with_scope(
        requested: &Path,
        check: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(Self, String), String> {
        Self::inspect_inner(requested, check, true)
    }

    fn inspect_inner(
        requested: &Path,
        check: impl FnOnce(&Path) -> Result<(), String>,
        scoped: bool,
    ) -> Result<(Self, String), String> {
        let (target, parent) = resolve_target(requested)?;
        // Check the canonical parent plus the original leaf before reading
        // the review snapshot. open_target must see the leaf, not the
        // destination of a symlink, so its link checks remain effective.
        check(&target)?;
        let (original, before) = match open_target(&target)? {
            Some((mut file, stamp)) => {
                let bytes = read_snapshot(&mut file, stamp.len, scoped)?;
                check_version(&target, &file, &stamp)?;
                let digest = Sha256::digest(&bytes).into();
                let text = String::from_utf8(bytes).map_err(|_| {
                    "Cannot read current file (binary or unreadable encoding). Refusing to propose change.".to_string()
                })?;
                (Some(FileVersion { stamp, digest }), text)
            }
            None => (None, String::new()),
        };
        Ok((
            Self {
                target,
                parent,
                original,
            },
            before,
        ))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.target
    }

    pub(crate) fn existed(&self) -> bool {
        self.original.is_some()
    }

    pub(crate) fn apply(&self, requested: &Path, content: &str) -> Result<(), String> {
        self.check_destination(requested)?;
        let staged = self.stage(content)?;
        self.commit(requested, staged)
    }

    fn check_destination(&self, requested: &Path) -> Result<(), String> {
        let (target, parent) = resolve_target(requested)?;
        if target != self.target || parent != self.parent {
            return Err(
                "Conflict: the destination directory changed since review. Request a new proposal."
                    .into(),
            );
        }
        Ok(())
    }

    fn stage(&self, content: &str) -> Result<NamedTempFile, String> {
        let parent = self.target.parent().expect("reviewed target has a parent");
        let mut staged = tempfile::Builder::new()
            .prefix(".anybot-write-")
            .tempfile_in(parent)
            .map_err(|e| format!("Cannot stage the reviewed write: {e}"))?;
        staged
            .write_all(content.as_bytes())
            .map_err(|e| format!("Cannot stage the reviewed write: {e}"))?;
        if let Some(original) = &self.original {
            #[cfg(unix)]
            {
                let meta = staged.as_file().metadata().map_err(|e| e.to_string())?;
                if FileStamp::of(&meta).owner != original.stamp.owner {
                    return Err(
                        "Cannot preserve the file's owner and group. Nothing was replaced.".into(),
                    );
                }
            }
            staged
                .as_file()
                .set_permissions(original.stamp.permissions.clone())
                .map_err(|e| e.to_string())?;
            check_extended_metadata(staged.as_file())?;
        }
        staged
            .as_file()
            .sync_all()
            .map_err(|e| format!("Cannot sync the staged write: {e}"))?;
        Ok(staged)
    }

    fn commit(&self, requested: &Path, staged: NamedTempFile) -> Result<(), String> {
        let _commit = WRITE_COMMIT
            .lock()
            .map_err(|_| "Cannot lock reviewed file publication.")?;
        self.check_destination(requested)?;
        if let Some(original) = &self.original {
            let Some((mut file, stamp)) = open_target(&self.target)? else {
                return Err(
                    "Conflict: the file was deleted after review. Request a new proposal.".into(),
                );
            };
            if stamp != original.stamp || digest_file(&mut file, stamp.len)? != original.digest {
                return Err(changed_file());
            }
            check_version(&self.target, &file, &stamp)?;
            drop(file);
            staged
                .persist(&self.target)
                .map_err(|e| format!("Cannot replace the reviewed file: {}", e.error))?;
        } else {
            // No separate absence check could prevent another save between a
            // check and rename. The publish operation itself must not clobber.
            staged.persist_noclobber(&self.target).map_err(|e| {
                if e.error.kind() == io::ErrorKind::AlreadyExists {
                    "Conflict: a file appeared at the reviewed destination. Request a new proposal."
                        .to_string()
                } else {
                    format!(
                        "Cannot publish the new file without replacing an existing entry: {}",
                        e.error
                    )
                }
            })?;
        }
        Ok(())
    }
}

fn resolve_target(path: &Path) -> Result<(PathBuf, FileIdentity), String> {
    const PROTECTED: &str = "PROTECTED: this file is part of AnyBot's own configuration and cannot be modified by tools.";
    if is_protected_file(path) {
        return Err(PROTECTED.into());
    }
    let name = path.file_name().ok_or("Choose a path with a file name.")?;
    #[cfg(windows)]
    {
        let name = name.to_string_lossy();
        if name.contains(':') || name.ends_with([' ', '.']) {
            return Err(
                "Choose a regular Windows file name, not a stream or an ambiguous path.".into(),
            );
        }
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Use an existing destination directory: {e}"))?;
    let meta = fs::metadata(&parent)
        .map_err(|e| format!("Cannot inspect the destination directory: {e}"))?;
    if !meta.is_dir() {
        return Err("The destination parent is not a directory.".into());
    }
    let target = parent.join(name);
    if is_protected_file(&target) {
        return Err(PROTECTED.into());
    }
    Ok((target, FileIdentity::of(&meta)))
}

fn open_target(path: &Path) -> Result<Option<(File, FileStamp)>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot inspect the reviewed file: {e}")),
    };
    check_regular_file(&meta)?;
    let stamp = FileStamp::of(&meta);
    let mut options = OpenOptions::new();
    // Check write access without changing or truncating the destination.
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Cannot open the reviewed file: {e}"))?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    check_regular_file(&opened)?;
    if FileStamp::of(&opened) != stamp {
        return Err(changed_file());
    }
    check_extended_metadata(&file)?;
    Ok(Some((file, stamp)))
}

fn check_regular_file(meta: &Metadata) -> Result<(), String> {
    if !meta.is_file() {
        return Err("Only regular files can be replaced. Symbolic links and special files are not supported.".into());
    }
    if meta.permissions().readonly() {
        return Err("The file is read-only. Nothing was replaced.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 || meta.mode() & 0o7000 != 0 {
            return Err(
                "Hard-linked files and files with special permission bits cannot be replaced."
                    .into(),
            );
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & REPARSE_POINT != 0 {
            return Err("Windows reparse points cannot be replaced.".into());
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn check_extended_metadata(file: &File) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    // SAFETY: the File owns a live descriptor, and size=0 queries the length
    // without writing through the null buffer.
    #[cfg(target_os = "linux")]
    let size = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0) };
    #[cfg(target_os = "macos")]
    let size = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0, 0) };
    match size {
        0 => Ok(()),
        n if n > 0 => Err(
            "This file has extended attributes that AnyBot cannot preserve. Nothing was replaced."
                .into(),
        ),
        _ => {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ENOTSUP) {
                Ok(())
            } else {
                Err(format!("Cannot check extended file attributes: {err}"))
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn check_extended_metadata(_file: &File) -> Result<(), String> {
    Ok(())
}

fn check_version(path: &Path, file: &File, expected: &FileStamp) -> Result<(), String> {
    let current = file.metadata().map_err(|e| e.to_string())?;
    let named =
        fs::symlink_metadata(path).map_err(|e| format!("Cannot verify the reviewed file: {e}"))?;
    check_regular_file(&named)?;
    if FileStamp::of(&current) != *expected || FileStamp::of(&named) != *expected {
        return Err(changed_file());
    }
    Ok(())
}

fn read_snapshot(reader: impl Read, advertised_len: u64, scoped: bool) -> Result<Vec<u8>, String> {
    let oversized = || format!(
        "Existing file exceeds the {MAX_TEXT_MIB} MiB workspace review limit. Edit it outside the workspace tool."
    );
    let limit = if scoped {
        if advertised_len > MAX_TEXT_BYTES as u64 {
            return Err(oversized());
        }
        // Do not rely on metadata alone: independently cap the bytes read.
        MAX_TEXT_BYTES as u64 + 1
    } else {
        advertised_len.saturating_add(1)
    };
    let mut bytes = Vec::new();
    reader
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read the file for review: {e}"))?;
    if scoped && bytes.len() > MAX_TEXT_BYTES {
        return Err(oversized());
    }
    Ok(bytes)
}

fn digest_file(file: &mut File, len: u64) -> Result<[u8; 32], String> {
    let mut reader = file.take(len.saturating_add(1));
    let mut digest = Sha256::new();
    let mut buf = [0; 8192];
    loop {
        let count = reader
            .read(&mut buf)
            .map_err(|e| format!("Cannot verify the reviewed file: {e}"))?;
        if count == 0 {
            return Ok(digest.finalize().into());
        }
        digest.update(&buf[..count]);
    }
}

fn changed_file() -> String {
    "Conflict: the file changed since review. Request a new proposal.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_snapshot_caps_actual_bytes_even_when_metadata_understates_length() {
        let mut reader = io::Cursor::new(vec![0; MAX_TEXT_BYTES + 32]);
        let error = read_snapshot(&mut reader, 0, true).unwrap_err();
        assert!(error.contains("1 MiB workspace review limit"), "{error}");
        assert_eq!(reader.position(), (MAX_TEXT_BYTES + 1) as u64);
    }

    #[test]
    fn ordinary_save_after_staging_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, "reviewed text").unwrap();
        let (reviewed, _) = ReviewedFile::inspect(&path).unwrap();
        let staged = reviewed.stage("approved replacement").unwrap();
        let stage_path = staged.path().to_path_buf();

        fs::write(&path, "later edit from another editor").unwrap();
        let error = reviewed.commit(&path, staged).unwrap_err();
        assert!(error.starts_with("Conflict:"), "{error}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "later edit from another editor"
        );
        assert!(!stage_path.exists());
    }

    #[test]
    fn new_file_commit_refuses_to_replace_an_entry_created_after_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        let (reviewed, _) = ReviewedFile::inspect(&path).unwrap();
        assert!(!reviewed.existed());
        let staged = reviewed.stage("approved new file").unwrap();
        let stage_path = staged.path().to_path_buf();

        fs::write(&path, "created by another editor").unwrap();
        let error = reviewed.commit(&path, staged).unwrap_err();
        assert!(error.starts_with("Conflict:"), "{error}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "created by another editor"
        );
        assert!(!stage_path.exists());
    }

    #[test]
    fn separate_attempts_stage_in_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        let (reviewed, _) = ReviewedFile::inspect(&path).unwrap();
        let first = reviewed.stage("first").unwrap();
        let second = reviewed.stage("second").unwrap();
        assert_ne!(first.path(), second.path());
        assert_eq!(fs::read_to_string(first.path()).unwrap(), "first");
        assert_eq!(fs::read_to_string(second.path()).unwrap(), "second");
        assert!(!path.exists());
        drop((first, second));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn approved_new_file_publishes_exact_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        let (reviewed, _) = ReviewedFile::inspect(&path).unwrap();
        reviewed.apply(&path, "reviewed text\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"reviewed text\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn existing_directory_must_still_be_the_reviewed_one() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("work");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("notes.txt");
        let (reviewed, _) = ReviewedFile::inspect(&path).unwrap();
        fs::rename(&parent, dir.path().join("archive")).unwrap();
        fs::create_dir(&parent).unwrap();

        let error = reviewed.apply(&path, "approved text").unwrap_err();
        assert!(error.contains("destination directory changed"), "{error}");
        assert!(!path.exists());
    }
}
