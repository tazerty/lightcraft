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
//! Not yet (Revela's target, HOST-PROTOCOL.md §9.2): `doc.save` and `doc.request-save` (what
//! `evora:save` carries is Revela's open question Q-REV-18), `doc.saved-ack`, `doc.dirty`,
//! `doc.multi`, `export.drive` (REV-02), `pick.drive`, `command` (REV-06).

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
pub const CAPABILITIES: [&str; 5] = ["doc.open", "storage.memory", "storage.purge", "live.lang", "live.theme"];
/// The admitted parent origins, next to `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
const CAPABILITY_NAMES: [&str; 18] = [
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
];
/// Message ids remembered against replays (then forgotten, oldest first).
const MAX_SEEN: usize = 4096;

/// What the host asks of the app, applied on its next frame (`web::WebApp`), which answers it.
pub enum HostEvent {
    /// `evora:init` (after the start-up purge): the engine's language (`None`: English, the host
    /// shows its banner) and the appearance.
    Init { id: String, lang: Option<String>, dark: bool },
    /// `evora:open`: a photo's bytes and file name.
    Open { id: String, doc_ref: String, name: String, bytes: Vec<u8> },
    Lang { id: String, lang: Option<String> },
    Theme { id: String, dark: bool },
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
    storage_ns: String,
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
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
                storage_ns: String::new(),
                seen: VecDeque::new(),
                seen_set: HashSet::new(),
            });
        });
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
        // unknown here, or a capability this engine doesn't declare: ignored (§4.1, §10)
        _ => return,
    };
    if let Some(c) = capability
        && !effective(c)
    {
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
    // `evora:init` answers `evora:ready`; the others are requests, which carry no `re` (§3)
    if (kind == "evora:init") != re.is_some() {
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
    let Some(max_document) = max_document else { return };
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
    let (message, id) = envelope(kind, re, payload)?;
    LINK.with(|l| {
        let l = l.try_borrow().ok()?;
        let l = l.as_ref()?;
        l.parent.post_message(&message, &l.origin).ok().map(|()| id)
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
