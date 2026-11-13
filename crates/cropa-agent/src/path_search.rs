//! Finds a CLI on `PATH` without ever running something from the current
//! directory.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

fn extensions(pathext: Option<&OsStr>) -> Vec<String> {
    pathext
        .map_or_else(|| DEFAULT_PATHEXT.into(), |p| p.to_string_lossy())
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
        .collect()
}

fn has_pathext_extension(name: &str, exts: &[String]) -> bool {
    exts.iter().any(|ext| {
        name.len() > ext.len()
            && name.is_char_boundary(name.len() - ext.len())
            && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext)
    })
}

fn candidates(dir: &Path, name: &str, pathext: Option<&OsStr>) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return vec![dir.join(name)];
    }
    let exts = extensions(pathext);
    if has_pathext_extension(name, &exts) {
        return vec![dir.join(name)];
    }
    exts.iter()
        .map(|ext| dir.join(format!("{name}{ext}")))
        .collect()
}

/// The first file named `name` in an absolute `path` entry. On Windows a name
/// without a `PATHEXT` extension is tried with each extension in order.
/// Relative entries are skipped, and a `name` holding a path separator is
/// refused.
pub fn find_in(name: &str, path: &OsStr, pathext: Option<&OsStr>) -> Option<PathBuf> {
    if name.is_empty() || name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return None;
    }
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| candidates(&dir, name, pathext))
        .find(|candidate| candidate.is_file())
}

/// [`find_in`] over the current `PATH` and `PATHEXT`.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let pathext = std::env::var_os("PATHEXT");
    find_in(name, &path, pathext.as_deref())
}

#[cfg(all(test, windows))]
mod tests {
    use std::ffi::OsString;

    use super::*;
    use crate::turn_dir::TurnDir;

    fn path_of(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    fn lower(path: &Path) -> String {
        path.to_string_lossy().to_lowercase()
    }

    #[test]
    fn cmd_is_found_for_a_bare_name() {
        let dir = TurnDir::new().unwrap();
        std::fs::write(dir.path().join("tool.cmd"), b"").unwrap();
        let found = find_in("tool", &path_of(&[dir.path()]), None).unwrap();
        assert!(found.is_absolute());
        assert!(lower(&found).ends_with("tool.cmd"));
    }

    #[test]
    fn pathext_order_decides_between_matches() {
        let dir = TurnDir::new().unwrap();
        std::fs::write(dir.path().join("tool.exe"), b"").unwrap();
        std::fs::write(dir.path().join("tool.cmd"), b"").unwrap();
        let path = path_of(&[dir.path()]);
        let found = find_in("tool", &path, Some(OsStr::new(".CMD;.EXE"))).unwrap();
        assert!(lower(&found).ends_with("tool.cmd"));
        let found = find_in("tool", &path, Some(OsStr::new(".EXE;.CMD"))).unwrap();
        assert!(lower(&found).ends_with("tool.exe"));
    }

    #[test]
    fn a_name_with_an_extension_is_used_as_is() {
        let dir = TurnDir::new().unwrap();
        std::fs::write(dir.path().join("tool.cmd"), b"").unwrap();
        let path = path_of(&[dir.path()]);
        assert!(find_in("tool.cmd", &path, None).is_some());
        assert!(find_in("tool.cmd.cmd", &path, None).is_none());
    }

    #[test]
    fn relative_entries_and_separators_are_refused() {
        let dir = TurnDir::new().unwrap();
        std::fs::write(dir.path().join("tool.cmd"), b"").unwrap();
        assert!(find_in("tool", OsStr::new("."), None).is_none());
        let with_dir = format!("{}\\tool", dir.path().display());
        assert!(find_in(&with_dir, &path_of(&[dir.path()]), None).is_none());
    }

    #[test]
    fn a_missing_tool_is_none() {
        let dir = TurnDir::new().unwrap();
        assert!(find_in("nothing-here", &path_of(&[dir.path()]), None).is_none());
    }
}
