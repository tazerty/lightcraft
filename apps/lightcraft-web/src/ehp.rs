//! Evora (E4): the native Evora host protocol bridge, EHP v1 (`apps/creative/HOST-PROTOCOL.md` in
//! Evora), on the model of pdfcraft's (EVORA-COL-12). With `?host=evora` the engine talks to its
//! parent page only when that page's origin is admitted by `evora-host.json`, served next to
//! `index.html` and written there when Evora provisions the build (`{"parentOrigins": [...]}`,
//! bare http(s) origins; empty in the build artefact, which keeps the bridge silent). The admitted
//! origins never come from a URL parameter, a message or the referrer alone: the browser's own
//! record of the parent (`location.ancestorOrigins`) decides when it exists, and must be admitted;
//! otherwise the referrer may only pick among the admitted origins, or the single one (§2.3).
//!
//! Every message is `{ v: 1, type, id, re?, payload }` (§3). An incoming message is examined only
//! if `event.source` is the parent window AND `event.origin` the admitted parent origin (§5.1),
//! then checked in the order of §5.2: a plain object, version 1, a type handled here, a capability
//! in the effective set, the exact envelope (no other field), `id` (and `re`, only where the
//! message answers one) as ULIDs, an id not seen before, the payload's schema, bytes as an
//! `ArrayBuffer` (never a `SharedArrayBuffer` or a typed view) within `maxDocumentBytes`, and
//! `re` matching the `evora:ready` for `evora:init`. Anything else is ignored, unanswered.
//! Outgoing messages name the admitted parent origin as `targetOrigin`, never `*`, with new ULIDs.
//!
//! Handled: `evora:init` (language converted by the host's E3 mapping, theme; `storageNs` for the
//! start-up purge of every other namespace and of the leftovers, §7.7 b), `evora:open` (a photo's
//! bytes, imported in memory and made the active photo; answered once imported), `evora:lang`,
//! `evora:theme`, `evora:purge` (answered once the storage is actually empty, [`crate::purge`]).
//! Sent: `evora:ready`, `evora:ack`, `evora:failed {code}` when the engine can't start or stops.
//!
//! Evora (EVORA-REV-29, Revela's save bridge; Revela's CdC §5, HOST-PROTOCOL §4, §6, §7.2 to §7.6,
//! §7.9 and §7.10): each photo the host opens is one of its documents (`docRef`, `doc.multi`).
//! Handled as well: `evora:request-save` (answered by an `evora:save` per modified photo, whose
//! bytes are the `revela-save` envelope, or `evora:ack {code: "clean"}`), `evora:saved` (the photo
//! is saved only on `ok: true`, and only if it hasn't changed since: `doc.saved-ack`),
//! `evora:command` (the compiled list of [`crate::host_docs::COMMANDS`] only, any other refused
//! with `capability`), `evora:activate`, and the host's `evora:ack` of the engine's own requests.
//! Sent as well: `evora:dirty {dirty, docRef}`, `evora:save`, `evora:active`, `evora:closed`,
//! `evora:export` (every file the engine writes goes to Evora's Drive, never to a download),
//! `evora:pick {purpose: "open"}` (the engine's file picker is the host's), `evora:focus-out`
//! (F6, [`crate::host_keys`]). What each document holds is [`crate::host_docs`].

use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};

use js_sys::{Array, Function, Object, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use crate::storage_names::{Scope, valid_namespace};

/// Build slug and protocol version announced in `evora:ready` (§4.4, §10).
const APP: &str = "revela";
const EHP: &str = "1.0";
/// What this engine honours (§9.1), each exercised by the CI smoke scenario « pont-ehp ».
/// `storage.memory`: under the host the engine keeps nothing in browser storage. `storage.ns` is
/// not declared: with nothing stored there is nothing to put in a namespace (Revela's CdC §5.1).
/// EVORA-REV-29: the save bridge (`doc.*`, `command`), exports and picker (`export.drive`,
/// `pick.drive`) and the way out at the keyboard (`ui.focus-out`, A-19).
pub const CAPABILITIES: [&str; 14] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.multi",
    "doc.request-save",
    "export.drive",
    "pick.drive",
    "command",
    "storage.memory",
    "storage.purge",
    "live.lang",
    "live.theme",
    "ui.focus-out",
];
/// The admitted parent origins, next to `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
const CAPABILITY_NAMES: [&str; 19] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.multi",
    "doc.request-save",
    "export.drive",
    "media.need",
    "media.ranges",
    "pick.drive",
    "command",
    "storage.ns",
    "storage.memory",
    "storage.purge",
    "live.lang",
    "live.theme",
    "font.inject",
    "author",
    "ui.focus-out",
];
/// Message ids remembered against replays (then forgotten, oldest first).
const MAX_SEEN: usize = 4096;
/// The engine's own requests still waiting for the host's answer (saves, exports, picks), at most.
const MAX_PENDING: usize = 256;
/// `{EHP_MAX_ACCEPT_ITEMS}`: the host's default (`creative_ehp_max_accept_items`, to arbitrate).
const MAX_ACCEPT_ITEMS: usize = 32;
/// `ackCode` of §4.2: what the host may answer in `evora:saved.error` or `evora:ack.code`.
const ACK_CODES: [&str; 16] = [
    "clean", "cancelled", "conflict", "too_large", "quota", "forbidden", "not_found", "invalid_content", "unsupported", "rate_limited",
    "read_only", "busy", "capability", "network", "server", "timeout",
];

/// What the host asks of the app, applied on its next frame (`web::WebApp`), which answers it.
pub enum HostEvent {
    /// `evora:init` (after the start-up purge): the engine's language (`None`: English, the host
    /// shows its banner) and the appearance.
    Init { id: String, lang: Option<String>, dark: bool },
    /// `evora:open`: a photo's bytes and file name.
    Open { id: String, doc_ref: String, name: String, bytes: Vec<u8> },
    Lang { id: String, lang: Option<String> },
    Theme { id: String, dark: bool },
    /// `evora:request-save` (§4.3): one photo, or every modified one (`None`).
    RequestSave { id: String, doc_ref: Option<String> },
    /// `evora:saved` answering the engine's `evora:save` `re`; `doc_ref`: the new document a copy
    /// made (§7.3).
    Saved { re: String, ok: bool, doc_ref: Option<String> },
    /// `evora:command` of the compiled list ([`crate::host_docs::COMMANDS`]).
    Command { id: String, command: String, params: serde_json::Value },
    /// `evora:activate` (§7.10): show this document.
    Activate { id: String, doc_ref: String },
    /// Ctrl+S or Cmd+S in the engine ([`crate::host_keys`]): save the photo shown.
    SaveShortcut,
}

struct Link {
    parent: web_sys::Window,
    origin: String,
    ready_id: String,
    /// `evora:init` accepted (a second one is ignored).
    init_received: bool,
    /// `evora:init` applied: the start-up purge is over, the requests of the effective
    /// capabilities are examined from now on (before, they are ignored, §5.2 step 5).
    initialized: bool,
    /// The effective capabilities: what the host offers in `evora:init` and this engine declares.
    caps: Vec<String>,
    max_document: f64,
    max_export: f64,
    storage_ns: String,
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
    /// The engine's `evora:save` ids waiting for their `evora:saved`.
    saves: VecDeque<String>,
    /// The engine's `evora:export` and `evora:pick` ids waiting for the host's `evora:ack`.
    asks: VecDeque<String>,
}

thread_local! {
    static LINK: RefCell<Option<Link>> = const { RefCell::new(None) };
    static EVENTS: RefCell<VecDeque<HostEvent>> = const { RefCell::new(VecDeque::new()) };
    /// The engine couldn't start, or stopped: the code to send in `evora:failed`.
    static FAILED: Cell<Option<&'static str>> = const { Cell::new(None) };
    static FAILED_SENT: Cell<bool> = const { Cell::new(false) };
}

/// The next request of the host, in arrival order.
pub fn next_event() -> Option<HostEvent> {
    EVENTS.with(|e| e.borrow_mut().pop_front())
}

fn push(event: HostEvent) {
    EVENTS.with(|e| e.borrow_mut().push_back(event));
    crate::web::request_repaint();
}

/// Queue a request for the app's next frame from elsewhere in the bridge ([`crate::host_keys`]).
pub fn push_event(event: HostEvent) {
    push(event);
}

/// Read `evora-host.json`, find the admitted parent, listen, then announce `evora:ready` (before
/// any access to browser storage and any document, §4.4).
pub fn connect() {
    wasm_bindgen_futures::spawn_local(async {
        let Some((window, parent, origin)) = admitted_parent().await else {
            log::warn!("lightcraft: ?host=evora without an admitted parent page (evora-host.json): the host bridge stays silent");
            return;
        };
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(receive);
        if window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_err() {
            return;
        }
        // the listener lives as long as the page
        on_message.forget();
        LINK.with(|l| {
            *l.borrow_mut() = Some(Link {
                parent,
                origin,
                ready_id: String::new(),
                init_received: false,
                initialized: false,
                caps: Vec::new(),
                max_document: 0.0,
                max_export: 0.0,
                storage_ns: String::new(),
                seen: VecDeque::new(),
                seen_set: HashSet::new(),
                saves: VecDeque::new(),
                asks: VecDeque::new(),
            });
        });
        // F6 (`ui.focus-out`) and Ctrl+S (`doc.save`), held back from the canvas (EVORA-REV-29)
        crate::host_keys::listen(&window);
        // the engine already failed: say so instead of announcing it
        if let Some(code) = FAILED.with(Cell::get) {
            send_failed(code);
            return;
        }
        let capabilities = Array::new();
        for c in CAPABILITIES {
            capabilities.push(&JsValue::from_str(c));
        }
        let fields = [
            ("app", JsValue::from_str(APP)),
            ("version", JsValue::from_str(env!("CARGO_PKG_VERSION"))),
            ("ehp", JsValue::from_str(EHP)),
            ("capabilities", capabilities.into()),
        ];
        if let Some(payload) = object(&fields)
            && let Some(id) = send("evora:ready", None, &payload)
        {
            LINK.with(|l| {
                if let Some(l) = l.borrow_mut().as_mut() {
                    l.ready_id = id;
                }
            });
            log::info!("lightcraft: Evora host bridge connected");
        }
    });
}

/// The engine couldn't start, or can't go on: `evora:failed {code}` to an admitted parent, once
/// (§4.4). Before the bridge is connected, it is sent instead of `evora:ready`.
pub fn report_failure(code: &'static str) {
    if FAILED.with(Cell::get).is_none() {
        FAILED.with(|f| f.set(Some(code)));
    }
    let connected = LINK.with(|l| l.try_borrow().is_ok_and(|l| l.is_some()));
    if connected {
        send_failed(code);
    }
}

fn send_failed(code: &'static str) {
    if FAILED_SENT.with(Cell::get) {
        return;
    }
    if let Some(payload) = object(&[("code", JsValue::from_str(code))])
        && send("evora:failed", None, &payload).is_some()
    {
        FAILED_SENT.with(|f| f.set(true));
    }
}

/// `evora:ack` for request `re` (§4.5); a negative one carries a code.
pub fn ack(re: &str, ok: bool, code: Option<&'static str>) {
    let mut fields = vec![("ok", JsValue::from_bool(ok))];
    if let Some(code) = code {
        fields.push(("code", JsValue::from_str(code)));
    }
    if let Some(payload) = object(&fields) {
        let _ = send("evora:ack", Some(re), &payload);
    }
}

/// `evora:ack {ok: true, result}` for `evora:command` `re` (§4.5): `result` goes as a JSON value.
pub fn ack_result(re: &str, result: &serde_json::Value) {
    let Ok(result) = js_sys::JSON::parse(&result.to_string()) else {
        ack(re, false, Some("invalid_content"));
        return;
    };
    if let Some(payload) = object(&[("ok", JsValue::from_bool(true)), ("result", result)]) {
        let _ = send("evora:ack", Some(re), &payload);
    }
}

/// Is capability `c` effective (offered by the host in `evora:init` and declared here)?
pub fn has(c: &str) -> bool {
    effective(c)
}

/// The host's `limits` of `evora:init` (`maxDocumentBytes`, `maxExportBytes`).
fn limits() -> (f64, f64) {
    LINK.with(|l| l.try_borrow().ok().and_then(|l| l.as_ref().map(|l| (l.max_document, l.max_export))).unwrap_or((0.0, 0.0)))
}

/// Remember an id the host must answer (oldest forgotten past [`MAX_PENDING`]).
fn remember(list: fn(&mut Link) -> &mut VecDeque<String>, id: &str) {
    LINK.with(|l| {
        if let Ok(mut l) = l.try_borrow_mut()
            && let Some(l) = l.as_mut()
        {
            let q = list(l);
            if q.len() >= MAX_PENDING {
                q.pop_front();
            }
            q.push_back(id.to_string());
        }
    });
}

/// Forget `re` if the host had to answer it; `false` if it was never asked (or answered already).
fn answered(list: fn(&mut Link) -> &mut VecDeque<String>, re: &str) -> bool {
    LINK.with(|l| {
        let Ok(mut l) = l.try_borrow_mut() else { return false };
        let Some(l) = l.as_mut() else { return false };
        let q = list(l);
        match q.iter().position(|id| id == re) {
            Some(i) => {
                q.remove(i);
                true
            }
            None => false,
        }
    })
}

/// A copy of `bytes` in a fresh `ArrayBuffer`, to transfer.
fn buffer(bytes: &[u8]) -> js_sys::ArrayBuffer {
    js_sys::Uint8Array::from(bytes).buffer()
}

/// `evora:save {docRef, name, saveAs: false, bytes}` (§4.4), `re` when it answers an
/// `evora:request-save`. Returns its id, or the EHP code why it can't go.
pub fn save(doc_ref: &str, name: &str, bytes: &[u8], re: Option<&str>) -> Result<String, &'static str> {
    if !effective("doc.save") {
        return Err("capability");
    }
    if bytes.is_empty() || bytes.len() as f64 > limits().0 {
        return Err("too_large");
    }
    let data = buffer(bytes);
    let payload = object(&[
        ("docRef", JsValue::from_str(doc_ref)),
        ("name", JsValue::from_str(name)),
        ("saveAs", JsValue::from_bool(false)),
        ("bytes", data.clone().into()),
    ])
    .ok_or("busy")?;
    let id = send_with("evora:save", re, &payload, Some(&data)).ok_or("busy")?;
    remember(|l| &mut l.saves, &id);
    Ok(id)
}

/// `evora:dirty {dirty, docRef}` (§4.4, `docRef` required under `doc.multi`).
pub fn dirty(doc_ref: &str, dirty: bool) {
    if effective("doc.dirty")
        && let Some(payload) = object(&[("dirty", JsValue::from_bool(dirty)), ("docRef", JsValue::from_str(doc_ref))])
    {
        let _ = send("evora:dirty", None, &payload);
    }
}

/// `evora:active {docRef}` or `evora:closed {docRef}` (§7.10).
pub fn tab(kind: &'static str, doc_ref: &str) {
    if effective("doc.multi")
        && let Some(payload) = object(&[("docRef", JsValue::from_str(doc_ref))])
    {
        let _ = send(kind, None, &payload);
    }
}

/// `evora:export {docRef?, name, mime, bytes}` (§4.4, §7.4): the file goes to Evora's Drive,
/// never to a download. Refused (an error the engine shows) when the host doesn't take exports.
pub fn export(doc_ref: Option<&str>, name: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    if !effective("export.drive") {
        return Err("exports go to Evora's Drive, which isn't reachable from this page".into());
    }
    if bytes.is_empty() || bytes.len() as f64 > limits().1 {
        return Err(format!("{name} is too large for Evora's Drive ({} bytes)", bytes.len()));
    }
    let data = buffer(bytes);
    let mut fields = Vec::new();
    if let Some(doc_ref) = doc_ref {
        fields.push(("docRef", JsValue::from_str(doc_ref)));
    }
    fields.push(("name", JsValue::from_str(name)));
    fields.push(("mime", JsValue::from_str(mime)));
    fields.push(("bytes", data.clone().into()));
    let payload = object(&fields).ok_or("the export couldn't be handed to Evora")?;
    let id = send_with("evora:export", None, &payload, Some(&data)).ok_or("the export couldn't be handed to Evora")?;
    remember(|l| &mut l.asks, &id);
    log::info!("lightcraft: {name} ({} bytes) handed to Evora's Drive", bytes.len());
    Ok(())
}

/// `evora:pick {purpose: "open", accept, multiple: true}` (§4.4, §7.6): the host's picker adds
/// photos, each as an `evora:open` of a new document. `false` when the host doesn't offer it.
pub fn pick_open(accept: &[String]) -> bool {
    if !effective("pick.drive") || accept.is_empty() {
        return false;
    }
    let list = Array::new();
    for a in accept.iter().take(MAX_ACCEPT_ITEMS) {
        list.push(&JsValue::from_str(a));
    }
    let Some(payload) = object(&[("purpose", JsValue::from_str("open")), ("accept", list.into()), ("multiple", JsValue::from_bool(true))])
    else {
        return false;
    };
    match send("evora:pick", None, &payload) {
        Some(id) => {
            remember(|l| &mut l.asks, &id);
            true
        }
        None => false,
    }
}

/// `evora:focus-out {}` (A-19, §7.9): the host moves the keyboard focus to « Leave the editor ».
pub fn focus_out() {
    if effective("ui.focus-out") {
        let _ = send("evora:focus-out", None, &Object::new());
    }
}

/// The parent window and its origin, when the page is framed by an origin `evora-host.json`
/// admits.
async fn admitted_parent() -> Option<(web_sys::Window, web_sys::Window, String)> {
    let window = web_sys::window()?;
    let parent = window.parent().ok().flatten()?;
    if Object::is(&parent, &window) {
        return None;
    }
    let admitted = read_config(&window).await?;
    // `location.ancestorOrigins` (a DOMStringList; read by name, absent from some browsers)
    let location: JsValue = window.location().into();
    let ancestors = get(&location, "ancestorOrigins");
    let first_ancestor = (get(&ancestors, "length").as_f64().unwrap_or(0.0) >= 1.0)
        .then(|| Reflect::get_u32(&ancestors, 0).ok().and_then(|o| o.as_string()))
        .flatten();
    let origin = match first_ancestor {
        Some(parent_origin) => Some(parent_origin).filter(|o| admitted.contains(o))?,
        None => {
            let referrer = window.document().map(|d| d.referrer()).unwrap_or_default();
            let from_referrer = web_sys::Url::new(&referrer).ok().map(|u| u.origin()).filter(|o| admitted.contains(o));
            match (from_referrer, admitted.as_slice()) {
                (Some(o), _) => o,
                (None, [only]) => only.clone(),
                _ => return None,
            }
        }
    };
    Some((window, parent, origin))
}

/// `evora-host.json`: `{ "parentOrigins": ["https://…", …] }`, each a bare web origin; fetched
/// from this page's own folder, never from the cache, never through a redirect.
async fn read_config(window: &web_sys::Window) -> Option<Vec<String>> {
    let fetch: Function = Reflect::get(window, &"fetch".into()).ok()?.dyn_into().ok()?;
    let init = object(&[("cache", "no-store".into()), ("credentials", "same-origin".into()), ("redirect", "error".into())])?;
    let pending: Promise = fetch.call2(window, &JsValue::from_str(CONFIG), &init).ok()?.dyn_into().ok()?;
    let response = JsFuture::from(pending).await.ok()?;
    if get(&response, "ok").as_bool() != Some(true) {
        return None;
    }
    let text: Function = get(&response, "text").dyn_into().ok()?;
    let text: Promise = text.call0(&response).ok()?.dyn_into().ok()?;
    let text = JsFuture::from(text).await.ok()?.as_string()?;
    let config = js_sys::JSON::parse(&text).ok()?;
    let list = get(&config, "parentOrigins");
    if !Array::is_array(&list) {
        return None;
    }
    let origins: Vec<String> = Array::from(&list).iter().filter_map(|o| o.as_string()).filter(|o| is_origin(o)).collect();
    (!origins.is_empty()).then_some(origins)
}

/// `http(s)://host[:port]`, nothing after.
fn is_origin(o: &str) -> bool {
    let rest = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.contains(['/', '?', '#', '@', ' ', '\\']))
}

fn receive(event: web_sys::MessageEvent) {
    // §5.1: source AND origin
    let from_parent = LINK.with(|l| {
        l.borrow().as_ref().is_some_and(|l| event.origin() == l.origin && event.source().is_some_and(|s| Object::is(&s, &l.parent)))
    });
    if !from_parent {
        return;
    }
    // §5.2: a plain object, version 1, a type handled here, its capability, the envelope
    let data = event.data();
    if !plain_object(&data) || get(&data, "v").as_f64() != Some(1.0) {
        return;
    }
    let Some(kind) = get(&data, "type").as_string() else { return };
    let capability = match kind.as_str() {
        "evora:init" => None,
        "evora:open" => Some("doc.open"),
        "evora:lang" => Some("live.lang"),
        "evora:theme" => Some("live.theme"),
        "evora:purge" => Some("storage.purge"),
        "evora:request-save" => Some("doc.request-save"),
        "evora:saved" => Some("doc.save"),
        "evora:command" => Some("command"),
        "evora:activate" => Some("doc.multi"),
        // the host's answer to one of the engine's requests: after `evora:init`, matched by `re`
        "evora:ack" => None,
        // unknown here, or a capability this engine doesn't declare: ignored (§4.1, §10)
        _ => return,
    };
    if let Some(c) = capability
        && !effective(c)
    {
        return;
    }
    if kind == "evora:ack" && !LINK.with(|l| l.borrow().as_ref().is_some_and(|l| l.initialized)) {
        return;
    }
    if !only_keys(&data, &["v", "type", "id", "re", "payload"]) {
        return;
    }
    let Some(id) = get(&data, "id").as_string().filter(|i| is_ulid(i)) else { return };
    let re = get(&data, "re");
    let re = if re.is_undefined() {
        None
    } else {
        match re.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    // `evora:init`, `evora:saved` and `evora:ack` answer the engine; the others are requests,
    // which carry no `re` (§3)
    let answer = matches!(kind.as_str(), "evora:init" | "evora:saved" | "evora:ack");
    if answer != re.is_some() {
        return;
    }
    let payload = get(&data, "payload");
    if !plain_object(&payload) || !first_time(&id) {
        return;
    }
    match kind.as_str() {
        "evora:init" => on_init(&id, re.as_deref().unwrap_or_default(), &payload),
        "evora:open" => on_open(&id, &payload),
        "evora:lang" => on_lang(&id, &payload),
        "evora:theme" => on_theme(&id, &payload),
        "evora:purge" => on_purge(&id, &payload),
        "evora:request-save" => on_request_save(&id, &payload),
        "evora:saved" => on_saved(re.as_deref().unwrap_or_default(), &payload),
        "evora:command" => on_command(&id, &payload),
        "evora:activate" => on_activate(&id, &payload),
        "evora:ack" => on_answer(re.as_deref().unwrap_or_default(), &payload),
        _ => {}
    }
}

/// Is capability `c` in the effective set (after `evora:init`)?
fn effective(c: &str) -> bool {
    LINK.with(|l| l.borrow().as_ref().is_some_and(|l| l.initialized && l.caps.iter().any(|have| have == c)))
}

/// Remember `id`; `false` if it was seen before (a replay, §3).
fn first_time(id: &str) -> bool {
    LINK.with(|l| {
        let mut l = l.borrow_mut();
        let Some(l) = l.as_mut() else { return false };
        if l.seen_set.contains(id) {
            return false;
        }
        if l.seen.len() >= MAX_SEEN
            && let Some(old) = l.seen.pop_front()
        {
            l.seen_set.remove(&old);
        }
        l.seen.push_back(id.to_string());
        l.seen_set.insert(id.to_string());
        true
    })
}

fn on_init(id: &str, re: &str, p: &JsValue) {
    let expected = LINK.with(|l| l.borrow().as_ref().is_some_and(|l| !l.init_received && !l.ready_id.is_empty() && l.ready_id == re));
    if !expected {
        return;
    }
    let required = ["lang", "engineLang", "theme", "accent", "readOnly", "storageNs", "capabilities", "prefs", "limits"];
    let mut allowed = required.to_vec();
    allowed.push("displayName");
    if !only_keys(p, &allowed) || required.iter().any(|k| get(p, k).is_undefined()) {
        return;
    }
    let lang_ok = get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str()));
    let Some(engine_lang) = engine_lang(&get(p, "engineLang")) else { return };
    let Some(dark) = theme(&get(p, "theme")) else { return };
    let accent_ok = is_accent(&get(p, "accent"));
    let read_only_ok = get(p, "readOnly").as_bool().is_some();
    let Some(ns) = get(p, "storageNs").as_string().filter(|ns| valid_namespace(ns)) else { return };
    let name = get(p, "displayName");
    let name_ok = name.is_undefined() || name.as_string().is_some_and(|n| (1..=100).contains(&n.chars().count()));
    let Some(caps) = string_list(&get(p, "capabilities")) else { return };
    let caps_ok = caps.iter().all(|c| CAPABILITY_NAMES.contains(&c.as_str()));
    let prefs = get(p, "prefs");
    let prefs_ok = plain_object(&prefs)
        && Object::values(prefs.unchecked_ref::<Object>()).iter().all(|v| v.as_string().is_some() || v.as_f64().is_some() || v.as_bool().is_some());
    let limits = get(p, "limits");
    let max_document = get(&limits, "maxDocumentBytes").as_f64();
    let max_export = get(&limits, "maxExportBytes").as_f64();
    let limits_ok = plain_object(&limits)
        && only_keys(&limits, &["maxDocumentBytes", "maxExportBytes"])
        && [max_document, max_export].iter().all(|m| m.is_some_and(|m| m >= 1.0 && m.fract() == 0.0));
    let (Some(max_document), Some(max_export)) = (max_document, max_export) else { return };
    if !(lang_ok && accent_ok && read_only_ok && name_ok && caps_ok && prefs_ok && limits_ok) {
        return;
    }
    // the effective set: what the host offers and this engine declares (§9)
    let caps: Vec<String> = caps.into_iter().filter(|c| CAPABILITIES.contains(&c.as_str())).collect();
    let purge = caps.iter().any(|c| c == "storage.purge");
    LINK.with(|l| {
        if let Some(l) = l.borrow_mut().as_mut() {
            l.init_received = true;
            l.caps = caps;
            l.max_document = max_document;
            l.max_export = max_export;
            l.storage_ns = ns.clone();
        }
    });
    let id = id.to_string();
    wasm_bindgen_futures::spawn_local(async move {
        // §7.1 step 6 and §7.7 b, before the answer: every namespace but the account's, and the
        // leftovers outside any namespace, are purged (best effort: a failure is logged, the
        // leftovers stay those of other sessions, never this page's writes, and the host's next
        // `evora:purge` is answered by what it achieves). Only then are the host's requests
        // examined, and the engine configured and the `evora:init` answered on the next frame.
        if purge {
            let _ = crate::purge::run(Scope::AllBut(ns)).await;
        }
        LINK.with(|l| {
            if let Some(l) = l.borrow_mut().as_mut() {
                l.initialized = true;
            }
        });
        push(HostEvent::Init { id, lang: engine_lang, dark });
    });
}

fn on_open(id: &str, p: &JsValue) {
    if !only_keys(p, &["docRef", "name", "bytes", "url", "new"]) {
        return;
    }
    let Some(doc_ref) = get(p, "docRef").as_string().filter(|r| is_ulid(r)) else { return };
    let Some(name) = get(p, "name").as_string().filter(|n| is_name(n)) else { return };
    if ["bytes", "url", "new"].iter().filter(|k| !get(p, k).is_undefined()).count() != 1 {
        return;
    }
    if !get(p, "url").is_undefined() {
        // `url` needs `media.ranges`, which this engine doesn't declare
        if get(p, "url").as_string().is_some() {
            ack(id, false, Some("capability"));
        }
        return;
    }
    if !get(p, "new").is_undefined() {
        if get(p, "new").as_bool() == Some(true) {
            ack(id, false, Some("unsupported"));
        }
        return;
    }
    let bytes = get(p, "bytes");
    // an ArrayBuffer (never a SharedArrayBuffer or a typed view), 1 byte up to the limit
    if !bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        return;
    }
    let length = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
    if length < 1.0 {
        return;
    }
    let max = LINK.with(|l| l.borrow().as_ref().map_or(0.0, |l| l.max_document));
    if length > max {
        ack(id, false, Some("too_large"));
        return;
    }
    let bytes = js_sys::Uint8Array::new(&bytes).to_vec();
    push(HostEvent::Open { id: id.to_string(), doc_ref, name, bytes });
}

fn on_lang(id: &str, p: &JsValue) {
    if !only_keys(p, &["lang", "engineLang"]) || !get(p, "lang").as_string().is_some_and(|l| LANGS.contains(&l.as_str())) {
        return;
    }
    let Some(lang) = engine_lang(&get(p, "engineLang")) else { return };
    push(HostEvent::Lang { id: id.to_string(), lang });
}

fn on_theme(id: &str, p: &JsValue) {
    if !only_keys(p, &["theme", "accent"]) || !is_accent(&get(p, "accent")) {
        return;
    }
    let Some(dark) = theme(&get(p, "theme")) else { return };
    // the accent is Evora's indigo already (patch E2); light or dark is what changes here
    push(HostEvent::Theme { id: id.to_string(), dark });
}

fn on_purge(id: &str, p: &JsValue) {
    let all = match get(p, "scope").as_string().as_deref() {
        Some("all") => true,
        Some("current") => false,
        _ => return,
    };
    if !only_keys(p, &["scope"]) {
        return;
    }
    let ns = LINK.with(|l| l.borrow().as_ref().map(|l| l.storage_ns.clone()).unwrap_or_default());
    let id = id.to_string();
    // §7.7: answered once the storage is actually empty (`purge::run` lists it again), never
    // before; a purge that couldn't remove everything is answered `busy`
    wasm_bindgen_futures::spawn_local(async move {
        let scope = if all { Scope::All } else { Scope::Current(ns) };
        match crate::purge::run(scope).await {
            Ok(_) => ack(&id, true, None),
            Err(_) => ack(&id, false, Some("busy")),
        }
    });
}

/// `evora:request-save {reason, docRef?}` (§4.3).
fn on_request_save(id: &str, p: &JsValue) {
    if !only_keys(p, &["reason", "docRef"]) {
        return;
    }
    let reasons = ["autosave", "visibility", "close", "logout", "user"];
    if !get(p, "reason").as_string().is_some_and(|r| reasons.contains(&r.as_str())) {
        return;
    }
    let doc_ref = get(p, "docRef");
    let doc_ref = if doc_ref.is_undefined() {
        None
    } else {
        match doc_ref.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    push(HostEvent::RequestSave { id: id.to_string(), doc_ref });
}

/// `evora:saved {ok, version?, docRef?, error?}` (§4.3), for an `evora:save` of this engine only.
fn on_saved(re: &str, p: &JsValue) {
    if !only_keys(p, &["ok", "version", "docRef", "error"]) {
        return;
    }
    let Some(ok) = get(p, "ok").as_bool() else { return };
    let version = get(p, "version");
    let error = get(p, "error");
    let doc_ref = get(p, "docRef");
    let valid = if ok {
        version.as_f64().is_some_and(|v| v >= 1.0 && v.fract() == 0.0) && error.is_undefined()
    } else {
        error.as_string().is_some_and(|e| ACK_CODES.contains(&e.as_str())) && version.is_undefined() && doc_ref.is_undefined()
    };
    let doc_ref = if doc_ref.is_undefined() {
        None
    } else {
        match doc_ref.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    // a response that answers no save of this engine is ignored (§3)
    if !valid || !answered(|l| &mut l.saves, re) {
        return;
    }
    push(HostEvent::Saved { re: re.to_string(), ok, doc_ref });
}

/// `evora:command {command, params}` (§4.3): a command off the compiled list is refused at once.
fn on_command(id: &str, p: &JsValue) {
    if !only_keys(p, &["command", "params"]) {
        return;
    }
    let Some(command) = get(p, "command").as_string().filter(|c| is_command(c)) else { return };
    let params = get(p, "params");
    if !plain_object(&params) {
        return;
    }
    // SABORDAGE QA (EVORA-REV-31) : commande hors liste acquittée ok (jamais exécutée) -> [ehp-command]
    if !crate::host_docs::COMMANDS.contains(&command.as_str()) {
        let _ = ack_result(id, &serde_json::Value::Null);
        return;
    }
    let text = js_sys::JSON::stringify(&params).ok().and_then(|t| t.as_string());
    let Some(params) = text.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        ack(id, false, Some("invalid_content"));
        return;
    };
    push(HostEvent::Command { id: id.to_string(), command, params });
}

/// `evora:activate {docRef}` (§7.10).
fn on_activate(id: &str, p: &JsValue) {
    if !only_keys(p, &["docRef"]) {
        return;
    }
    let Some(doc_ref) = get(p, "docRef").as_string().filter(|r| is_ulid(r)) else { return };
    push(HostEvent::Activate { id: id.to_string(), doc_ref });
}

/// The host's `evora:ack` of an `evora:export` or an `evora:pick` of this engine (§4.5); anything
/// else is ignored. A refusal is logged: the host words what it tells the member.
fn on_answer(re: &str, p: &JsValue) {
    if !only_keys(p, &["ok", "code", "result"]) {
        return;
    }
    let Some(ok) = get(p, "ok").as_bool() else { return };
    if !answered(|l| &mut l.asks, re) {
        return;
    }
    if !ok {
        log::warn!("lightcraft: Evora refused a request ({})", get(p, "code").as_string().unwrap_or_default());
    }
}

/// `command` of §4.3: `^[a-z][A-Za-z0-9_.-]*$`, at most 100 characters.
fn is_command(c: &str) -> bool {
    let mut chars = c.chars();
    c.len() <= 100
        && chars.next().is_some_and(|f| f.is_ascii_lowercase())
        && chars.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
}

/// `engineLang` of §4.2: `null` (the engine shows English, the host its banner) or a language tag.
fn engine_lang(v: &JsValue) -> Option<Option<String>> {
    if v.is_null() { Some(None) } else { v.as_string().filter(|l| is_lang_tag(l)).map(Some) }
}

/// `theme` of §4.2: `Some(true)` for dark, `Some(false)` for light.
fn theme(v: &JsValue) -> Option<bool> {
    match v.as_string().as_deref() {
        Some("dark") => Some(true),
        Some("light") => Some(false),
        _ => None,
    }
}

/// `accent` of §4.2: `#RRGGBB`.
fn is_accent(v: &JsValue) -> bool {
    v.as_string().is_some_and(|a| a.len() == 7 && a.starts_with('#') && a.chars().skip(1).all(|c| c.is_ascii_hexdigit()))
}

/// Post a message to the admitted parent origin; returns its `id`.
fn send(kind: &str, re: Option<&str>, payload: &Object) -> Option<String> {
    send_with(kind, re, payload, None)
}

/// [`send`], transferring `data` (the message's `bytes`) instead of copying it.
fn send_with(kind: &str, re: Option<&str>, payload: &Object, data: Option<&js_sys::ArrayBuffer>) -> Option<String> {
    let (message, id) = envelope(kind, re, payload)?;
    LINK.with(|l| {
        let l = l.try_borrow().ok()?;
        let l = l.as_ref()?;
        let sent = match data {
            Some(data) => l.parent.post_message_with_transfer(&message, &l.origin, &Array::of1(data)),
            None => l.parent.post_message(&message, &l.origin),
        };
        sent.ok().map(|()| id)
    })
}

fn envelope(kind: &str, re: Option<&str>, payload: &Object) -> Option<(Object, String)> {
    let id = ulid();
    let mut fields = vec![("v", JsValue::from_f64(1.0)), ("type", JsValue::from_str(kind)), ("id", JsValue::from_str(&id))];
    if let Some(re) = re {
        fields.push(("re", JsValue::from_str(re)));
    }
    fields.push(("payload", payload.clone().into()));
    Some((object(&fields)?, id))
}

fn object(fields: &[(&str, JsValue)]) -> Option<Object> {
    let m = Object::new();
    for (key, value) in fields {
        Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn get(data: &JsValue, key: &str) -> JsValue {
    if !data.is_object() {
        return JsValue::UNDEFINED;
    }
    Reflect::get(data, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

/// A plain object: not null, not an array, prototype `Object.prototype` (§5.2 step 2).
fn plain_object(v: &JsValue) -> bool {
    if !v.is_object() || Array::is_array(v) {
        return false;
    }
    let plain = Object::get_prototype_of(&Object::new().into());
    Object::is(&Object::get_prototype_of(v), &plain)
}

/// No property outside `allowed` (`additionalProperties: false`).
fn only_keys(v: &JsValue, allowed: &[&str]) -> bool {
    if !v.is_object() {
        return false;
    }
    Object::keys(v.unchecked_ref::<Object>()).iter().all(|k| k.as_string().is_some_and(|k| allowed.contains(&k.as_str())))
}

/// An array of distinct strings.
fn string_list(v: &JsValue) -> Option<Vec<String>> {
    if !Array::is_array(v) {
        return None;
    }
    let list: Vec<String> = Array::from(v).iter().map(|x| x.as_string()).collect::<Option<Vec<_>>>()?;
    let mut unique = list.clone();
    unique.sort();
    unique.dedup();
    (unique.len() == list.len()).then_some(list)
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// A new ULID: 48 bits of milliseconds, then 80 random bits (§3: unique per sender).
fn ulid() -> String {
    let mut time = js_sys::Date::now() as u64;
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().take(10).rev() {
        *slot = CROCKFORD[(time % 32) as usize];
        time /= 32;
    }
    for slot in out.iter_mut().skip(10) {
        *slot = CROCKFORD[((js_sys::Math::random() * 32.0) as usize) % 32];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `name` of §4.2: 1 to 255 characters, no `/`, `\` or control character.
fn is_name(n: &str) -> bool {
    (1..=255).contains(&n.chars().count()) && !n.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

/// `engineLang` of §4.2: `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`.
fn is_lang_tag(tag: &str) -> bool {
    let mut parts = tag.split(['-', '_']);
    let first_ok = parts.next().is_some_and(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()));
    first_ok && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}
