//! The environment variables a CLI child may inherit.

use std::ffi::{OsStr, OsString};

/// What a CLI needs to start and reach the network. Everything else (tokens,
/// API keys, other tools' settings) is dropped. Adapters may extend it.
pub const BASE_ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "HOME",
    "LANG",
    "TMPDIR",
];

fn same_name(name: &OsStr, allowed: &str) -> bool {
    if cfg!(windows) {
        name.eq_ignore_ascii_case(allowed)
    } else {
        name == allowed
    }
}

/// Keeps the pairs whose name is in `allow`. Names match case-insensitively
/// on Windows and exactly elsewhere.
pub fn filter_env(
    source: impl IntoIterator<Item = (OsString, OsString)>,
    allow: &[&str],
) -> Vec<(OsString, OsString)> {
    source
        .into_iter()
        .filter(|(name, _)| allow.iter().any(|allowed| same_name(name, allowed)))
        .collect()
}

/// The current process environment reduced to [`BASE_ENV_ALLOWLIST`].
pub fn base_env() -> Vec<(OsString, OsString)> {
    filter_env(std::env::vars_os(), BASE_ENV_ALLOWLIST)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        items.iter().map(|(k, v)| (k.into(), v.into())).collect()
    }

    #[test]
    fn only_allowed_names_pass() {
        let out = filter_env(
            pairs(&[("PATH", "/bin"), ("CROPA_TEST_SECRET", "1"), ("LANG", "C")]),
            BASE_ENV_ALLOWLIST,
        );
        assert_eq!(out, pairs(&[("PATH", "/bin"), ("LANG", "C")]));
    }

    #[cfg(windows)]
    #[test]
    fn names_match_case_insensitively_on_windows() {
        let out = filter_env(
            pairs(&[("Path", "C:\\x"), ("systemroot", "C:\\W")]),
            BASE_ENV_ALLOWLIST,
        );
        assert_eq!(out.len(), 2);
    }

    #[cfg(not(windows))]
    #[test]
    fn names_match_exactly_elsewhere() {
        let out = filter_env(pairs(&[("Path", "/x")]), BASE_ENV_ALLOWLIST);
        assert!(out.is_empty());
    }
}
