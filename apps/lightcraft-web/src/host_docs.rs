//! Evora (EVORA-REV-29, REV-F-PONT and REV-F-EXPORT of Revela's plan): the host's documents in the
//! engine, under the bridge ([`crate::ehp`]).
//!
//! Revela develops photos of Evora's Drive: each photo the host opens (`evora:open`) is one of its
//! documents, named by its `docRef` (capability `doc.multi`, HOST-PROTOCOL §7.10). The original is
//! never written back: what the host saves is the `revela-save` envelope (Revela's CdC §5.2), the
//! develop settings and the XMP sidecar made in the same frame, from which Evora keeps the settings
//! and writes the sidecar next to the original.
//!
//! - **Modified** (`doc.dirty`): a photo is modified when its state (develop settings, rating, flag,
//!   label, metadata) differs from the one last saved, or applied as the baseline by
//!   `revela.apply`; each change is told once, `evora:dirty {dirty, docRef}`.
//! - **Save** (`doc.request-save`, `doc.save`, `doc.saved-ack`): `evora:request-save` gets one
//!   `evora:save` per modified photo (the first carries `re`), or `evora:ack {code: "clean"}`. A
//!   photo becomes saved only on `evora:saved {ok: true}`, and only if it hasn't changed since the
//!   save was sent; otherwise it stays modified (§4.5).
//! - **Commands** (`command`): the compiled list [`COMMANDS`] only (CdC §5.3); `revela.apply
//!   {docRef, settings | xmp, baseline?}` applies Evora's settings or a sidecar to a photo, as the
//!   new baseline unless `baseline: false`; `develop.get {docRef}` and `develop.controls {section?}`
//!   are the engine's own queries.
//! - **Shown photo** (`evora:active`, `evora:activate`) and **removed photo** (`evora:closed`).
//! - **Exports** (`export.drive`): every file the engine writes goes to Evora's Drive
//!   (`evora:export`), never to a download; its `docRef` is the photo the file was made from, by
//!   the original's content hash in its path, else by the longest photo name its name starts with
//!   (none when two photos tie: the field is optional).
//! - **XMP auto-write** is held off: the host writes the sidecar, never the engine.

use std::cell::RefCell;
use std::hash::{Hash, Hasher};

use lightcraft_engine::Selection;
use lightcraft_engine::catalog::{PhotoId, Source};
use lightcraft_ui_egui::LightcraftApp;
use serde_json::{Value, json};

/// The commands the host may run through `evora:command` (Revela's CdC §5.3), compiled in. Any
/// other is refused on arrival with `capability` ([`crate::ehp`]).
pub const COMMANDS: [&str; 3] = ["revela.apply", "develop.get", "develop.controls"];

/// The envelope of `evora:save` (Revela's CdC §5.2).
const ENVELOPE_FORMAT: &str = "revela-save";
const ENVELOPE_VERSION: u32 = 1;
/// The name `evora:save` gives the envelope (indicative: Evora names the sidecar itself).
const ENVELOPE_SUFFIX: &str = ".revela.json";
/// `name` of HOST-PROTOCOL §4.2: at most 255 characters.
const MAX_NAME_CHARS: usize = 255;
/// `{EHP_MAX_COMMAND_RESULT_BYTES}`: the host's default (`creative_ehp_max_command_result_bytes`).
const MAX_COMMAND_RESULT_BYTES: usize = 65_536;
/// How often the photos' state is compared with what the host was told (seconds).
const CHECK_EVERY_S: f64 = 0.25;
/// The history label of `revela.apply`.
const APPLY_LABEL: &str = "Evora";

/// One of the host's documents.
struct Doc {
    doc_ref: String,
    photo: PhotoId,
    /// The state last saved, or applied as the baseline ([`fingerprint`]).
    baseline: u64,
    /// The `evora:save` messages waiting for their `evora:saved`, with the state each carried.
    in_flight: Vec<(String, u64)>,
    /// What the host was last told (`evora:dirty`).
    told_dirty: Option<bool>,
}

/// The host's documents open in the engine, oldest first.
#[derive(Default)]
pub struct HostDocs {
    docs: Vec<Doc>,
    /// The `docRef` of the last `evora:active`.
    told_active: Option<String>,
    next_check: f64,
}

/// What the export writer needs of each document: `docRef`, the original's content hash and
/// lowercase name stem (the writer runs inside an engine command, away from the app).
#[derive(Clone)]
struct ExportName {
    doc_ref: String,
    hash: String,
    stem: String,
}

thread_local! {
    static EXPORT_NAMES: RefCell<Vec<ExportName>> = const { RefCell::new(Vec::new()) };
}

/// The state of photo `photo` that a save keeps: develop settings, rating, flag, label, metadata.
fn fingerprint(app: &LightcraftApp, photo: PhotoId) -> Option<u64> {
    let p = app.session.catalog.photo(photo)?;
    let state = json!({"develop": &*p.develop, "rating": p.rating, "flag": p.flag, "label": p.label, "meta": &p.meta});
    let mut h = std::hash::DefaultHasher::new();
    state.to_string().hash(&mut h);
    Some(h.finish())
}

/// The `revela-save` envelope of photo `photo` (CdC §5.2): settings as `develop.get` gives them,
/// rendering process, engine version, marks, and the XMP sidecar, all from this frame's state.
fn envelope(app: &LightcraftApp, photo: PhotoId) -> Option<Vec<u8>> {
    let s = &app.session;
    let p = s.catalog.photo(photo)?;
    let d = s.develop_of(photo)?;
    let mut settings = d.to_json();
    if let Some(o) = settings.as_object_mut() {
        o.insert("process".into(), json!(d.process));
    }
    let xmp = lightcraft_engine::sidecar::sidecar_packet(p, &s.catalog);
    let envelope = json!({
        "format": ENVELOPE_FORMAT,
        "version": ENVELOPE_VERSION,
        "settings": settings,
        "process": d.process,
        "engine": env!("CARGO_PKG_VERSION"),
        "meta": {"rating": p.rating, "label": p.label, "flag": p.flag},
        "xmp": xmp,
    });
    serde_json::to_vec(&envelope).ok()
}

/// `name` of HOST-PROTOCOL §4.2 from a file name: no `/`, `\` or control character, at most 255
/// characters (`suffix` kept whole).
fn host_name(name: &str, suffix: &str) -> String {
    let clean: String = name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect();
    let room = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
    let mut out: String = clean.chars().take(room).collect();
    if out.is_empty() {
        out.push_str("photo");
    }
    out.push_str(suffix);
    out
}

/// A file name's stem, lowercase.
fn stem_of(name: &str) -> String {
    name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_lowercase()
}

impl HostDocs {
    fn index(&self, doc_ref: &str) -> Option<usize> {
        self.docs.iter().position(|d| d.doc_ref == doc_ref)
    }

    /// What the export writer reads: kept in step with the documents.
    fn sync_names(&self, app: &LightcraftApp) {
        let names: Vec<ExportName> = self
            .docs
            .iter()
            .filter_map(|d| {
                let p = app.session.catalog.photo(d.photo)?;
                let hash = match &p.source {
                    Source::File { path } => crate::store::hash_of_path(path).unwrap_or_default().to_string(),
                    _ => String::new(),
                };
                let name = p.copy_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| p.file_name.clone());
                Some(ExportName { doc_ref: d.doc_ref.clone(), hash, stem: stem_of(&name) })
            })
            .collect();
        EXPORT_NAMES.with(|n| *n.borrow_mut() = names);
    }

    fn tell_dirty(&mut self, i: usize, dirty: bool) {
        if let Some(d) = self.docs.get_mut(i)
            && d.told_dirty != Some(dirty)
        {
            d.told_dirty = Some(dirty);
            crate::ehp::dirty(&d.doc_ref, dirty);
        }
    }

    /// `evora:open` of `doc_ref` imported as `photo`: the document is bound to it (a second
    /// document of the same photo gets its own virtual copy, so two documents never share their
    /// settings). Returns the photo bound; the photo becomes the one shown.
    pub fn bind(&mut self, app: &mut LightcraftApp, doc_ref: &str, photo: PhotoId) -> PhotoId {
        let shared = self.docs.iter().any(|d| d.photo == photo && d.doc_ref != doc_ref);
        let photo = if shared {
            let copy = app.run("photo.virtualCopy", json!({"ids": [photo.0]})).ok();
            copy.and_then(|r| r["ids"].as_array().and_then(|a| a.first()).and_then(Value::as_u64)).map_or(photo, PhotoId)
        } else {
            photo
        };
        app.session.selection = Selection::single(photo);
        let baseline = fingerprint(app, photo).unwrap_or_default();
        match self.index(doc_ref) {
            // the same document again: its content is the host's again (« Reload the server's version »)
            Some(i) => {
                let d = &mut self.docs[i];
                d.photo = photo;
                d.baseline = baseline;
                d.in_flight.clear();
                d.told_dirty = None;
            }
            None => self.docs.push(Doc { doc_ref: doc_ref.to_string(), photo, baseline, in_flight: Vec::new(), told_dirty: None }),
        }
        self.sync_names(app);
        photo
    }

    /// After the `evora:ack` of an open: `evora:dirty {dirty: false}` (§7.1 step 8).
    pub fn opened(&mut self, doc_ref: &str) {
        if let Some(i) = self.index(doc_ref) {
            self.tell_dirty(i, false);
        }
        self.next_check = 0.0;
    }

    /// Once a frame: auto-write held off; then, at most every [`CHECK_EVERY_S`], photos removed
    /// (`evora:closed`), modified or saved (`evora:dirty`), and the photo shown (`evora:active`).
    pub fn check(&mut self, app: &mut LightcraftApp, ctx: &egui::Context) {
        if app.session.xmp.auto_write {
            app.session.xmp.auto_write = false;
            log::info!("lightcraft: XMP auto-write held off under the host (Evora writes the sidecar)");
        }
        if self.docs.is_empty() {
            return;
        }
        let now = ctx.input(|i| i.time);
        if now < self.next_check {
            ctx.request_repaint_after(std::time::Duration::from_secs_f64(self.next_check - now));
            return;
        }
        self.next_check = now + CHECK_EVERY_S;
        let gone: Vec<String> = self
            .docs
            .iter()
            .filter(|d| app.session.catalog.photo(d.photo).is_none_or(|p| p.deleted))
            .map(|d| d.doc_ref.clone())
            .collect();
        if !gone.is_empty() {
            for doc_ref in &gone {
                crate::ehp::tab("evora:closed", doc_ref);
                if self.told_active.as_deref() == Some(doc_ref.as_str()) {
                    self.told_active = None;
                }
            }
            self.docs.retain(|d| !gone.contains(&d.doc_ref));
            self.sync_names(app);
        }
        for i in 0..self.docs.len() {
            if let Some(state) = fingerprint(app, self.docs[i].photo) {
                let dirty = state != self.docs[i].baseline;
                self.tell_dirty(i, dirty);
            }
        }
        let active = app.session.selection.active;
        if let Some(d) = self.docs.iter().find(|d| Some(d.photo) == active)
            && self.told_active.as_deref() != Some(d.doc_ref.as_str())
        {
            crate::ehp::tab("evora:active", &d.doc_ref);
            self.told_active = Some(d.doc_ref.clone());
        }
    }

    /// Send the envelope of document `i` (state `state`), `re` when it answers a request.
    fn send_save(&mut self, app: &LightcraftApp, i: usize, state: u64, re: Option<&str>) -> Result<(), &'static str> {
        let (photo, doc_ref) = (self.docs[i].photo, self.docs[i].doc_ref.clone());
        let bytes = envelope(app, photo).ok_or("not_found")?;
        let file_name = app.session.catalog.photo(photo).map(|p| p.file_name.clone()).unwrap_or_default();
        let id = crate::ehp::save(&doc_ref, &host_name(&file_name, ENVELOPE_SUFFIX), &bytes, re)?;
        if crate::ehp::has("doc.saved-ack") {
            self.docs[i].in_flight.push((id, state));
        } else {
            // without the host's acknowledgement the save counts as done once sent (§4.1)
            self.docs[i].baseline = state;
            self.tell_dirty(i, false);
        }
        Ok(())
    }

    /// `evora:request-save {docRef?}` (§4.3, §7.10 rule 5).
    pub fn request_save(&mut self, app: &LightcraftApp, id: &str, doc_ref: Option<&str>) {
        let targets: Vec<usize> = match doc_ref {
            Some(r) => match self.index(r) {
                Some(i) => vec![i],
                None => {
                    crate::ehp::ack(id, false, Some("not_found"));
                    return;
                }
            },
            None => (0..self.docs.len()).collect(),
        };
        let mut answered = false;
        for i in targets {
            let Some(state) = fingerprint(app, self.docs[i].photo) else { continue };
            if state == self.docs[i].baseline {
                continue;
            }
            match self.send_save(app, i, state, (!answered).then_some(id)) {
                Ok(()) => answered = true,
                Err(code) if doc_ref.is_some() => {
                    crate::ehp::ack(id, false, Some(code));
                    return;
                }
                Err(code) => log::warn!("lightcraft: a photo could not be sent to Evora ({code})"),
            }
        }
        if !answered {
            crate::ehp::ack(id, true, Some("clean"));
        }
    }

    /// Ctrl+S in the engine: the photo shown, if it is one of the host's and modified.
    pub fn save_shown(&mut self, app: &LightcraftApp) {
        let active = app.session.selection.active;
        let Some(i) = self.docs.iter().position(|d| Some(d.photo) == active) else { return };
        let Some(state) = fingerprint(app, self.docs[i].photo) else { return };
        if state != self.docs[i].baseline
            && let Err(code) = self.send_save(app, i, state, None)
        {
            log::warn!("lightcraft: the photo could not be sent to Evora ({code})");
        }
    }

    /// `evora:saved` for save `re` (§4.3, §4.5): saved only on `ok`, and only if unchanged since.
    pub fn saved(&mut self, app: &LightcraftApp, re: &str, ok: bool, doc_ref: Option<String>) {
        let Some(i) = self.docs.iter().position(|d| d.in_flight.iter().any(|(id, _)| id == re)) else { return };
        let Some(k) = self.docs[i].in_flight.iter().position(|(id, _)| id == re) else { return };
        let (_, state) = self.docs[i].in_flight.remove(k);
        if !ok {
            // stays modified: the host shows why, and saves again later
            return;
        }
        self.docs[i].baseline = state;
        // a copy (§7.3): the document now goes by its new reference
        if let Some(new_ref) = doc_ref
            && self.index(&new_ref).is_none()
        {
            if self.told_active.as_deref() == Some(self.docs[i].doc_ref.as_str()) {
                self.told_active = Some(new_ref.clone());
            }
            self.docs[i].doc_ref = new_ref;
            self.sync_names(app);
        }
        if fingerprint(app, self.docs[i].photo) == Some(state) {
            self.tell_dirty(i, false);
        }
    }

    /// `evora:activate {docRef}` (§7.10 rule 4): `busy` while a dialog of the engine is open.
    pub fn activate(&mut self, app: &mut LightcraftApp, id: &str, doc_ref: &str) {
        let Some(i) = self.index(doc_ref) else {
            crate::ehp::ack(id, false, Some("not_found"));
            return;
        };
        if app.ui.dialog.is_some() {
            crate::ehp::ack(id, false, Some("busy"));
            return;
        }
        app.session.selection = Selection::single(self.docs[i].photo);
        crate::ehp::ack(id, true, None);
        // `evora:active` follows on the next check, after the acknowledgement
        self.next_check = 0.0;
    }

    /// `evora:command` of [`COMMANDS`], answered with its result or a code.
    pub fn command(&mut self, app: &mut LightcraftApp, id: &str, command: &str, params: &Value) {
        let result = match command {
            "revela.apply" => self.apply(app, params),
            "develop.get" => self.develop_get(app, params),
            "develop.controls" => develop_controls(app, params),
            _ => Err("capability"),
        };
        match result {
            Ok(v) if v.to_string().len() <= MAX_COMMAND_RESULT_BYTES => crate::ehp::ack_result(id, &v),
            Ok(_) => crate::ehp::ack(id, false, Some("too_large")),
            Err(code) => crate::ehp::ack(id, false, Some(code)),
        }
    }

    /// The document named by `params.docRef`, the only parameter besides `allowed`.
    fn doc_of(&self, params: &Value, allowed: &[&str]) -> Result<usize, &'static str> {
        let o = params.as_object().ok_or("invalid_content")?;
        if o.keys().any(|k| k != "docRef" && !allowed.contains(&k.as_str())) {
            return Err("invalid_content");
        }
        let doc_ref = o.get("docRef").and_then(Value::as_str).ok_or("invalid_content")?;
        self.index(doc_ref).ok_or("not_found")
    }

    /// `revela.apply {docRef, settings | xmp, baseline?}` (CdC §5.2): Evora's settings (a partial
    /// or complete settings object, merged as Apply Settings JSON does) or an XMP sidecar (read as
    /// Read Metadata from File does, from the text), as one history step; the result becomes the
    /// photo's baseline unless `baseline` is `false`.
    fn apply(&mut self, app: &mut LightcraftApp, params: &Value) -> Result<Value, &'static str> {
        let i = self.doc_of(params, &["settings", "xmp", "baseline"])?;
        let photo = self.docs[i].photo;
        let baseline = match params.get("baseline") {
            None => true,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err("invalid_content"),
        };
        let op = match (params.get("settings"), params.get("xmp")) {
            (Some(settings), None) if settings.is_object() => {
                let current = app.session.develop_of(photo).ok_or("not_found")?;
                let merged = current.merged(settings).map_err(|_| "invalid_content")?;
                app.session.develop_op(photo, merged, APPLY_LABEL).ok_or("not_found")?
            }
            (None, Some(xmp)) => {
                let xmp = xmp.as_str().filter(|x| !x.trim().is_empty()).ok_or("invalid_content")?;
                let target = lightcraft_engine::crs::Target::for_photo(app.session.catalog.photo(photo).ok_or("not_found")?);
                let sidecar = lightcraft_engine::sidecar::parse_sidecar(xmp, target).map_err(|_| "invalid_content")?;
                app.session.sidecar_op(photo, sidecar).map_err(|_| "invalid_content")?
            }
            _ => return Err("invalid_content"),
        };
        app.session.commit(APPLY_LABEL, op).map_err(|_| "invalid_content")?;
        let state = fingerprint(app, photo).unwrap_or_default();
        if baseline {
            self.docs[i].baseline = state;
            self.tell_dirty(i, false);
        }
        self.next_check = 0.0;
        Ok(json!({"applied": true, "dirty": state != self.docs[i].baseline}))
    }

    /// `develop.get {docRef}`: the engine's own query, for the document's photo.
    fn develop_get(&self, app: &mut LightcraftApp, params: &Value) -> Result<Value, &'static str> {
        let i = self.doc_of(params, &[])?;
        app.run("develop.get", json!({"id": self.docs[i].photo.0})).map_err(|_| "invalid_content")
    }

    /// The documents, for `web.stats` (diagnostics of the CI bench and of Evora's lab).
    pub fn stats(&self, app: &LightcraftApp) -> Value {
        let docs: Vec<Value> = self
            .docs
            .iter()
            .map(|d| {
                let p = app.session.catalog.photo(d.photo);
                json!({
                    "docRef": d.doc_ref,
                    "photo": d.photo.0,
                    "name": p.map(|p| p.file_name.clone()),
                    "dirty": fingerprint(app, d.photo).is_some_and(|s| s != d.baseline),
                    "inFlight": d.in_flight.len(),
                })
            })
            .collect();
        json!({"docs": docs, "active": self.told_active, "autoWrite": app.session.xmp.auto_write})
    }
}

/// `develop.controls {section?}`: the engine's own query, for the photo shown.
fn develop_controls(app: &mut LightcraftApp, params: &Value) -> Result<Value, &'static str> {
    let o = params.as_object().ok_or("invalid_content")?;
    if o.keys().any(|k| k != "section") || o.get("section").is_some_and(|s| !s.is_string()) {
        return Err("invalid_content");
    }
    app.run("develop.controls", params.clone()).map_err(|_| "invalid_content")
}

/// The `docRef` of the photo an exported file was made from: by the original's content hash in
/// the path (« same folder as the original »), else by the longest photo name stem the file's
/// stem starts with; none when nothing matches or two photos tie.
fn export_doc_ref(path: &str, name: &str) -> Option<String> {
    EXPORT_NAMES.with(|names| {
        let names = names.borrow();
        if let Some(hash) = crate::store::hash_of_path(path) {
            let by_hash: Vec<&ExportName> = names.iter().filter(|n| n.hash == hash).collect();
            if let [only] = by_hash.as_slice() {
                return Some(only.doc_ref.clone());
            }
        }
        let stem = stem_of(name);
        let fits: Vec<&ExportName> = names.iter().filter(|n| !n.stem.is_empty() && stem.starts_with(&n.stem)).collect();
        let longest = fits.iter().map(|n| n.stem.len()).max()?;
        let best: Vec<&&ExportName> = fits.iter().filter(|n| n.stem.len() == longest).collect();
        match best.as_slice() {
            [only] => Some(only.doc_ref.clone()),
            _ => None,
        }
    })
}

/// The engine's file writer under the host (`Services::write`): every file goes to Evora's Drive
/// (`evora:export`), never to a download.
pub fn export_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    let name = host_name(crate::store::download_name(path), "");
    let mime = crate::store::mime_for(&name);
    let doc_ref = export_doc_ref(path, &name);
    crate::ehp::export(doc_ref.as_deref(), &name, mime, bytes)
}

/// EVORA-REV-33: what Evora's picker offers (`evora:pick.accept`), the types Evora opens in Revela,
/// in the order of `App\Services\Revela\RevelaFormats` (its `accepted` types, Revela's CdC F3-02).
/// The raws still `lab_pending` there (CR3, RAF, RW2 and RWL, PEF, ORF, SRW) are left out until
/// Evora's lab verifies them (Q-REV-07); `evora:open` still takes any type the engine imports, Evora
/// being the one that decides what it opens.
pub const ACCEPT: [&str; 14] = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".dng", ".cr2", ".nef", ".arw", ".psd", ".jxl", ".gif", ".bmp"];

/// The engine's file picker under the host (`Services::pick_files`): Evora's picker, whose photos
/// arrive as `evora:open` of new documents; nothing is returned now. It offers [`ACCEPT`], each
/// only if this build imports it too.
pub fn pick_files() -> Vec<String> {
    let imported = lightcraft_engine::import::accept_list();
    let accept: Vec<String> = ACCEPT.iter().copied().filter(|ext| imported.split(',').any(|i| i.trim() == *ext)).map(str::to_string).collect();
    if !crate::ehp::pick_open(&accept) {
        log::warn!("lightcraft: Evora's picker isn't available from this page");
    }
    Vec::new()
}
