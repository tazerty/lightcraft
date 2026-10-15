//! Evora (E5): purge of what LightCraft keeps in browser storage, asked by Evora's host only:
//! `evora:purge`, and `evora:init` for every namespace but the account's (HOST-PROTOCOL.md §7.7
//! in Evora), both received by the host bridge [`crate::ehp`] after its origin AND source checks.
//! Never from a URL parameter.
//!
//! Under the host (`?host=evora`) the engine keeps nothing in browser storage: memory mode is
//! forced, no storage backend is ever opened and the render workers get none (`web::Options`).
//! There is therefore no write of this page to stop, wait for or race with: a purge only finds
//! the leftovers of other sessions, under LightCraft's names ([`crate::storage_names`]).
//!
//! Nothing here opens anything for writing (no `create: true`). A purge removes, then lists again
//! and fails unless none of what it covers is left: the host's answer comes only once the storage
//! is actually empty. Purges run one at a time, in the order asked.

use std::cell::RefCell;

use js_sys::{Array, Function, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::FileSystemDirectoryHandle;

use crate::storage_names::{Scope, engine_key};

/// What a purge removed.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub opfs: Vec<String>,
    pub idb: Vec<String>,
    pub local_storage: Vec<String>,
}

thread_local! {
    /// The last purge asked (resolved when it ends): the next one waits for it.
    static CHAIN: RefCell<Option<Promise>> = const { RefCell::new(None) };
}

fn err(e: JsValue) -> String {
    e.as_string().or_else(|| e.dyn_ref::<js_sys::Error>().map(|e| String::from(e.message()))).unwrap_or_else(|| format!("{e:?}"))
}

/// Remove what `scope` covers, then check that none of it is left. One purge at a time.
pub async fn run(scope: Scope) -> Result<Report, String> {
    let mut done: Option<Function> = None;
    let mine = Promise::new(&mut |resolve, _| done = Some(resolve));
    if let Some(before) = CHAIN.with(|c| c.borrow_mut().replace(mine)) {
        let _ = JsFuture::from(before).await;
    }
    let result = purge(&scope).await;
    if let Some(done) = done {
        let _ = done.call0(&JsValue::NULL);
    }
    match &result {
        Ok(r) => log::info!("lightcraft: browser storage purged ({scope:?}): OPFS {:?}, IndexedDB {:?}, localStorage {:?}", r.opfs, r.idb, r.local_storage),
        Err(e) => log::warn!("lightcraft: purging browser storage ({scope:?}) failed: {e}"),
    }
    result
}

async fn purge(scope: &Scope) -> Result<Report, String> {
    let mut report = Report::default();
    let mut problems = Vec::new();
    if let Some(root) = opfs_root().await {
        match entries(&root).await {
            Ok(names) => {
                for name in names.into_iter().filter(|n| scope.covers(n, false)) {
                    let opts = web_sys::FileSystemRemoveOptions::new();
                    opts.set_recursive(true);
                    match JsFuture::from(root.remove_entry_with_options(&name, &opts)).await {
                        Ok(_) => report.opfs.push(name),
                        Err(e) if js_name(&e).as_deref() == Some("NotFoundError") => {}
                        Err(e) => problems.push(format!("OPFS {name}: {}", err(e))),
                    }
                }
            }
            Err(e) => problems.push(format!("listing OPFS: {e}")),
        }
    }
    if let Some(factory) = indexed_db() {
        let names = databases(&factory).await.unwrap_or_else(|| scope.known_databases());
        for name in names.into_iter().filter(|n| scope.covers(n, true)) {
            match delete_database(&factory, &name).await {
                Ok(()) => report.idb.push(name),
                Err(e) => problems.push(format!("IndexedDB {name}: {e}")),
            }
        }
    }
    if let Some(storage) = local_storage() {
        let remove = Reflect::get(&storage, &"removeItem".into()).and_then(|f| f.dyn_into::<Function>());
        for key in engine_keys(&storage) {
            match remove.as_ref().map_err(|e| e.clone()).and_then(|f| f.call1(&storage, &JsValue::from_str(&key))) {
                Ok(_) => report.local_storage.push(key),
                Err(e) => problems.push(format!("localStorage {key}: {}", err(e))),
            }
        }
    }
    // the host is answered "purged" only once nothing this purge covers is left
    let left = leftovers(scope).await;
    if !left.is_empty() {
        problems.push(format!("still there: {}", left.join(", ")));
    }
    if problems.is_empty() { Ok(report) } else { Err(problems.join("; ")) }
}

/// What `scope` covers that is still in this origin's storage (empty: purged). IndexedDB is
/// checked where the browser can list its databases.
pub async fn leftovers(scope: &Scope) -> Vec<String> {
    let mut left = Vec::new();
    if let Some(root) = opfs_root().await {
        match entries(&root).await {
            Ok(names) => left.extend(names.into_iter().filter(|n| scope.covers(n, false)).map(|n| format!("OPFS {n}"))),
            Err(e) => left.push(format!("OPFS unreadable ({e})")),
        }
    }
    if let Some(factory) = indexed_db()
        && let Some(names) = databases(&factory).await
    {
        left.extend(names.into_iter().filter(|n| scope.covers(n, true)).map(|n| format!("IndexedDB {n}")));
    }
    if let Some(storage) = local_storage() {
        left.extend(engine_keys(&storage).into_iter().map(|k| format!("localStorage {k}")));
    }
    left
}

fn js_name(e: &JsValue) -> Option<String> {
    Reflect::get(e, &"name".into()).ok().and_then(|n| n.as_string())
}

/// `navigator.storage.getDirectory()`: the OPFS root (getting it creates nothing).
async fn opfs_root() -> Option<FileSystemDirectoryHandle> {
    let nav = Reflect::get(&js_sys::global(), &"navigator".into()).ok()?;
    let storage = Reflect::get(&nav, &"storage".into()).ok().filter(|s| !s.is_undefined() && !s.is_null())?;
    let manager: web_sys::StorageManager = storage.unchecked_into();
    JsFuture::from(manager.get_directory()).await.ok().map(|root| root.unchecked_into())
}

/// Names of the entries in an OPFS directory.
async fn entries(dir: &FileSystemDirectoryHandle) -> Result<Vec<String>, String> {
    let keys = dir.keys();
    let mut out = Vec::new();
    loop {
        let next = JsFuture::from(keys.next().map_err(err)?).await.map_err(err)?;
        if Reflect::get(&next, &"done".into()).ok().is_some_and(|d| d.is_truthy()) {
            break;
        }
        if let Some(k) = Reflect::get(&next, &"value".into()).ok().and_then(|v| v.as_string()) {
            out.push(k);
        }
    }
    Ok(out)
}

fn indexed_db() -> Option<web_sys::IdbFactory> {
    let f = Reflect::get(&js_sys::global(), &"indexedDB".into()).ok()?;
    (!f.is_undefined() && !f.is_null()).then(|| f.unchecked_into())
}

/// The IndexedDB databases of this origin (`indexedDB.databases()`); `None` where the browser
/// can't list them.
async fn databases(factory: &web_sys::IdbFactory) -> Option<Vec<String>> {
    let f: Function = Reflect::get(factory, &"databases".into()).ok()?.dyn_into().ok()?;
    let p: Promise = f.call0(factory).ok()?.dyn_into().ok()?;
    let list: Array = JsFuture::from(p).await.ok()?.dyn_into().ok()?;
    Some(list.iter().filter_map(|d| Reflect::get(&d, &"name".into()).ok().and_then(|n| n.as_string())).collect())
}

/// `indexedDB.deleteDatabase(name)`, settled on success. An error, or another connection holding
/// the database open (`blocked`), is a failure: the host is then told the purge did not happen.
async fn delete_database(factory: &web_sys::IdbFactory, name: &str) -> Result<(), String> {
    let req = factory.delete_database(name).map_err(err)?;
    let r1 = req.clone();
    let p = Promise::new(&mut |resolve, reject| {
        let ok = Closure::once_into_js(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        let rej = reject.clone();
        let fail = Closure::once_into_js(move |e: JsValue| {
            let _ = rej.call1(&JsValue::NULL, &e);
        });
        let blocked = Closure::once_into_js(move || {
            let _ = reject.call1(&JsValue::NULL, &JsValue::from_str("blocked: another connection holds it open"));
        });
        r1.set_onsuccess(Some(ok.unchecked_ref()));
        r1.set_onerror(Some(fail.unchecked_ref()));
        r1.set_onblocked(Some(blocked.unchecked_ref()));
    });
    JsFuture::from(p).await.map(|_| ()).map_err(err)
}

/// `window.localStorage`, when this page may use it.
fn local_storage() -> Option<JsValue> {
    let w = web_sys::window()?;
    Reflect::get(&w, &"localStorage".into()).ok().filter(|s| !s.is_undefined() && !s.is_null())
}

/// The engine's `localStorage` keys.
fn engine_keys(storage: &JsValue) -> Vec<String> {
    let n = Reflect::get(storage, &"length".into()).ok().and_then(|n| n.as_f64()).unwrap_or(0.0) as u32;
    let Ok(key) = Reflect::get(storage, &"key".into()).and_then(|f| f.dyn_into::<Function>()) else { return Vec::new() };
    (0..n).filter_map(|i| key.call1(storage, &JsValue::from(i)).ok().and_then(|k| k.as_string())).filter(|k| engine_key(k)).collect()
}
