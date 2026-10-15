//! Evora (E5): the names LightCraft gives to what it keeps in browser storage, and which of them a
//! purge asked by Evora's host removes ([`crate::purge`] in the browser).
//!
//! The engine origin may be shared with Evora's other engines, and with Evora itself in its lab
//! mode A: a purge touches LightCraft's names only, never a whole origin.
//! - upstream's library outside any namespace: at the root of OPFS the folders `library/`,
//!   `library-<…>/` (restored backups), `originals/`, `thumbs/` and the file `active-library`;
//!   the IndexedDB database `lightcraft`;
//! - a namespace `lightcraft-ns-<id>` (an OPFS folder or an IndexedDB database of that name),
//!   where `<id>` is the host's `storageNs`. The prefix names the engine: Evora's engines share
//!   the origin, and a bare `ns-<id>` could be another engine's;
//! - `localStorage` keys starting with `lightcraft` (the engine writes none; purged anyway).

use crate::backup::valid_library_dir;

/// Upstream's IndexedDB database (outside any namespace).
pub const IDB_NAME: &str = "lightcraft";
/// Prefix of a namespace: OPFS folder or IndexedDB database `lightcraft-ns-<id>`.
pub const NS_PREFIX: &str = "lightcraft-ns-";
/// Upstream's OPFS root entries (besides the `library-<…>` folders of restored backups).
pub const ROOT_ENTRIES: [&str; 4] = ["library", "originals", "thumbs", "active-library"];
/// Prefix of the engine's `localStorage` keys.
pub const LOCAL_STORAGE_PREFIX: &str = "lightcraft";

/// What a purge removes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// `evora:init`: every namespace but `keep` (the account's), and the leftovers outside any
    /// namespace (HOST-PROTOCOL.md §7.7 b).
    AllBut(String),
    /// `evora:purge {scope: "current"}`: namespace `ns` and the leftovers outside any namespace.
    Current(String),
    /// `evora:purge {scope: "all"}`: every namespace and the leftovers.
    All,
}

/// A namespace id as Evora's host gives it (`storageNs`: 64 lowercase hexadecimal digits).
pub fn valid_namespace(ns: &str) -> bool {
    ns.len() == 64 && ns.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The namespace an OPFS entry or IndexedDB database belongs to (`lightcraft-ns-<id>`), if any.
fn namespace_of(name: &str) -> Option<&str> {
    name.strip_prefix(NS_PREFIX).filter(|id| !id.is_empty())
}

/// Is OPFS root entry `name` one of upstream's, outside any namespace?
fn upstream_root_entry(name: &str) -> bool {
    ROOT_ENTRIES.contains(&name) || valid_library_dir(name)
}

impl Scope {
    /// Does this purge remove the OPFS root entry (`idb` false) or IndexedDB database (`idb` true)
    /// named `name`?
    pub fn covers(&self, name: &str, idb: bool) -> bool {
        let leftover = if idb { name == IDB_NAME } else { upstream_root_entry(name) };
        if leftover {
            return true;
        }
        match (self, namespace_of(name)) {
            (_, None) => false,
            (Scope::All, Some(_)) => true,
            (Scope::AllBut(keep), Some(id)) => id != keep,
            (Scope::Current(ns), Some(id)) => id == ns,
        }
    }

    /// The IndexedDB databases this purge knows by name, for a browser that can't list them.
    pub fn known_databases(&self) -> Vec<String> {
        let mut names = vec![IDB_NAME.to_string()];
        if let Scope::Current(ns) = self {
            names.push(format!("{NS_PREFIX}{ns}"));
        }
        names
    }
}

/// Is `key` one of the engine's `localStorage` keys?
pub fn engine_key(key: &str) -> bool {
    key.starts_with(LOCAL_STORAGE_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn purges_cover_lightcraft_names_only() {
        for scope in [Scope::AllBut(A.into()), Scope::Current(A.into()), Scope::All] {
            for leftover in ["library", "library-20261013-101500", "originals", "thumbs", "active-library"] {
                assert!(scope.covers(leftover, false), "{scope:?} {leftover}");
            }
            assert!(scope.covers("lightcraft", true));
            for other in ["effectcraft-cache", "ns-x", "recovery", "media", "library-", "library-../x", "lightcraft-ns-", "photocraft.presets"] {
                assert!(!scope.covers(other, false) && !scope.covers(other, true), "{scope:?} {other}");
            }
        }
        let (ns_a, ns_b) = (format!("{NS_PREFIX}{A}"), format!("{NS_PREFIX}{B}"));
        assert!(!Scope::AllBut(A.into()).covers(&ns_a, false) && Scope::AllBut(A.into()).covers(&ns_b, true));
        assert!(Scope::Current(A.into()).covers(&ns_a, true) && !Scope::Current(A.into()).covers(&ns_b, false));
        assert!(Scope::All.covers(&ns_a, false) && Scope::All.covers(&ns_b, true));
    }

    #[test]
    fn namespaces_are_the_hosts_hex_ids() {
        assert!(valid_namespace(A) && valid_namespace(B));
        assert!(!valid_namespace(&B.to_uppercase()) && !valid_namespace(&A[1..]) && !valid_namespace("evoraTest1"));
    }

    #[test]
    fn engine_keys() {
        assert!(engine_key("lightcraft") && engine_key("lightcraft.prefs") && !engine_key("pdfcraft") && !engine_key("x-lightcraft"));
    }
}
