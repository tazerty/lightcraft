//! Evora (EVORA-REV-33, REV-F-FINITIONS of Revela's plan): the engine's menus and commands under
//! the host bridge ([`crate::ehp`]).
//!
//! - **Masked** (REV-07, REV-08, exception L5-REV-A of Revela's UPSTREAM): what makes no sense in
//!   Evora's Revela leaves the menus and does nothing at the keyboard ([`masked`], installed by
//!   `lightcraft_ui_egui::menubar::set_host_mask`): the library itself (libraries, backups, albums,
//!   folders, stacks, virtual copies, previews), imports Evora doesn't serve (folders, devices,
//!   catalogs, presets and keyword files), merges, named versions, model and data downloads,
//!   tracklogs, other editors, the app's own language, appearance and help pages. Evora's Drive is
//!   the only photo library (D-10); Evora's shell picks the language and the theme.
//! - **Catalog** (`command.catalog`, EVO-CMD of Evora's DT-S17): the commands Evora may run on
//!   request ([`catalog`], sent as `evora:commands`), a white list by construction: the menu
//!   entries of this build, minus what is masked, minus the shell's namespaces (`file.*` but the
//!   entries listed in [`FILE_ADMITTED`], every `app.*`, `help.*` and `prefs.*`), minus [`OFF_CATALOG`].
//!   A command takes no parameter (`{}`), except the four of [`DECLARED`], whose keys and values
//!   are checked one by one; a string that could name a path or a URL is refused. A command of
//!   [`DESTRUCTIVE`] runs only with `confirmed: true` (Evora asked the member first).
//! - `web.menus` ([`menus`]): the menus as displayed, for the CI bench and Evora's lab.

use lightcraft_ui_egui::LightcraftApp;
use lightcraft_ui_egui::menubar::MenuNode;
use serde_json::{Map, Value, json};

/// Masked command ids, and `@Name` for a whole submenu (English names, as the menus model has them).
const MASKED: &[&str] = &[
    // the library: libraries, backups, imports Evora doesn't serve, albums and folders, previews
    "app.newLibrary",
    "app.openLibrary",
    "app.recentLibraries",
    "app.clearRecentLibraries",
    "@Open Recent Library",
    "file.addFolder",
    "file.addFromDevice",
    "@Import from Device",
    "file.importLightroom",
    "file.findMissing",
    "file.backupLibrary",
    "file.restoreLibrary",
    "file.importPresets",
    "file.exportPresets",
    "file.importKeywords",
    "file.exportKeywords",
    "dialog.newAlbum",
    "dialog.newFolder",
    "dialog.smartAlbum",
    "dialog.newSmartAlbum",
    "album.create",
    "album.addPhotos",
    "album.removePhotos",
    "@Add to Album",
    "library.toggleAutoWriteXmp",
    "library.compact",
    "library.clearPreviews",
    "library.buildPreviews",
    "library.cancelPreviews",
    "library.smartPreviews",
    "@Previews",
    "dialog.print",
    "dialog.contactSheet",
    "app.quit",
    // stacks, virtual copies, duplicates, conversions, reloads from disk
    "stack.group",
    "stack.ungroup",
    "stack.remove",
    "stack.setTop",
    "stack.moveUp",
    "stack.moveDown",
    "stack.split",
    "stack.toggle",
    "stack.expandAll",
    "stack.collapseAll",
    "dialog.autoStack",
    "@Stack",
    "@Stacks",
    "photo.virtualCopy",
    "photo.duplicate",
    "photo.convertToDng",
    "photo.reload",
    "photo.addToLibrary",
    "app.showInFinder",
    "app.showInFolders",
    "dialog.rename",
    // the sidecar is Evora's to write (Ctrl+S saves to Evora's Drive)
    "photo.saveMetadataToFile",
    "photo.readMetadataFromFile",
    // merges, named versions, preset creation
    "dialog.mergeHdr",
    "dialog.mergePanorama",
    "dialog.mergeHdrPanorama",
    "merge.hdrLast",
    "merge.panoramaLast",
    "merge.hdrPanoramaLast",
    "merge.hdrBatch",
    "@Photo Merge",
    "version.create",
    "panel.versions",
    "dialog.createPreset",
    "preset.create",
    // model and data downloads, tracklogs, faces
    "faces.detect",
    "view.people",
    "view.person",
    "view.faceBoxes",
    "metadata.reverseGeocode",
    "metadata.downloadPlaceNames",
    "photo.tagFromTracklog",
    // other editors and windows, the layout image (a file of this computer)
    "photo.editInPhotoCraft",
    "photo.editInExternal",
    "photo.openOriginalInExternal",
    "@Edit In",
    "view.secondWindow",
    "dialog.slideshowExport",
    "view.chooseLayoutImage",
    "view.layoutImage",
    "view.layoutImageOpacity",
    "view.layoutImageMatte",
    "@Loupe Overlay",
    // Evora's shell picks the language and the theme; the sidebar shows the session's photos
    "@Language",
    "view.appearance",
    "view.theme",
    "@Appearance",
    "view.sidebarSection",
    "view.sidebarReset",
    "@Sidebar Sections",
    // the app's own pages and diagnostics
    "app.help",
    "app.feedback",
    "app.github",
    "app.whatsNew",
    "app.openLogFolder",
    "view.frameRate",
    "@Debug",
];

/// Is `id` (a command, or `@Name` for a submenu) masked in Evora's Revela? Every language command
/// is (Evora's shell sets the language).
pub fn masked(id: &str) -> bool {
    MASKED.contains(&id) || id.starts_with("app.language.")
}

/// The `file.*` entries Evora may run: each adds photos to the session through Evora itself
/// (Import Photos opens Evora's picker, `evora:pick`).
pub const FILE_ADMITTED: [&str; 1] = ["file.addPhotos"];

/// Menu entries left out of the catalog although not masked: they need a parameter the catalog
/// doesn't take (import paths, sort keys), or act on Recently Deleted, the library's own trash.
pub const OFF_CATALOG: [&str; 6] =
    ["library.import", "library.sort", "library.shuffle", "photo.restore", "photo.deletePermanently", "library.emptyRecentlyDeleted"];

/// The commands Evora runs only with `confirmed: true`: what the host loses without Edit › Undo
/// giving it back (a deleted photo leaves Evora's documents, `evora:closed`).
pub const DESTRUCTIVE: [&str; 1] = ["photo.delete"];

/// What one declared parameter takes.
#[derive(Clone, Copy)]
pub enum Kind {
    /// A whole number in this range.
    Int(i64, i64),
    /// One of these words.
    Word(&'static [&'static str]),
    /// `true` or `false`.
    Flag,
}

/// The commands that take a parameter: (command, key, what it takes, required). Any other key,
/// type or value is refused (`invalid_content`); every other command takes `{}`.
pub static DECLARED: [(&str, &str, Kind, bool); 4] = [
    ("photo.rate", "rating", Kind::Int(0, 5), true),
    ("photo.flag", "flag", Kind::Word(&["pick", "reject", "none"]), true),
    ("photo.label", "label", Kind::Word(&["red", "yellow", "green", "blue", "purple", "none"]), true),
    ("develop.treatment", "bw", Kind::Flag, false),
];

/// `{EHP_MAX_COMMAND_RESULT_BYTES}`: the host's default (`creative_ehp_max_command_result_bytes`).
const MAX_COMMAND_RESULT_BYTES: usize = 65_536;

/// May the catalog hold `id` (a static rule, the same in every state and every language)?
pub fn admitted(id: &str) -> bool {
    if masked(id) || OFF_CATALOG.contains(&id) {
        return false;
    }
    match id.split('.').next().unwrap_or_default() {
        "file" => FILE_ADMITTED.contains(&id),
        "app" | "help" | "prefs" => false,
        _ => true,
    }
}

/// The parameter schema of a declared command (JSON Schema, as Evora's shell reads it).
fn schema(id: &str) -> Option<Value> {
    let (_, key, kind, required) = DECLARED.iter().find(|(d, ..)| *d == id)?;
    let property = match kind {
        Kind::Int(min, max) => json!({"type": "integer", "minimum": min, "maximum": max}),
        Kind::Word(words) => json!({"type": "string", "enum": words}),
        Kind::Flag => json!({"type": "boolean"}),
    };
    let mut properties = Map::new();
    properties.insert((*key).to_string(), property);
    let mut s = Map::new();
    s.insert("type".into(), json!("object"));
    s.insert("additionalProperties".into(), json!(false));
    s.insert("properties".into(), Value::Object(properties));
    if *required {
        s.insert("required".into(), json!([key]));
    }
    Some(Value::Object(s))
}

/// A string that could name a path, a URL or the engine's storage (Evora's rule of 2026-10-27).
fn path_like(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    s.contains('/') || s.contains('\\') || s.contains("..") || s.contains(':') || lower.contains("opfs") || lower.contains("evora")
}

/// `params` of `evora:command` for catalog command `id`: `{}`, or the declared key with its value.
pub fn check_params(id: &str, params: &Value) -> Result<(), &'static str> {
    let o = params.as_object().ok_or("invalid_content")?;
    if o.values().any(|v| v.as_str().is_some_and(path_like)) {
        return Err("invalid_content");
    }
    let Some((_, key, kind, required)) = DECLARED.iter().find(|(d, ..)| *d == id) else {
        return if o.is_empty() { Ok(()) } else { Err("invalid_content") };
    };
    if o.keys().any(|k| k != key) {
        return Err("invalid_content");
    }
    let Some(v) = o.get(*key) else {
        return if *required { Err("invalid_content") } else { Ok(()) };
    };
    let fits = match kind {
        Kind::Int(min, max) => v.as_i64().is_some_and(|n| n >= *min && n <= *max),
        Kind::Word(words) => v.as_str().is_some_and(|w| words.contains(&w)),
        Kind::Flag => v.is_boolean(),
    };
    if fits { Ok(()) } else { Err("invalid_content") }
}

/// FNV-1a 64 bits, continued from `hash`.
fn fnv1a(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// The catalog (`evora:commands` payload): `lang` (the engine's language code), `count`, `hash`
/// (FNV-1a 64 of each id, its destructive flag and its declared schema, in order: the catalog's
/// identity, the same in every language and state), `params` (the default schema) and `commands`
/// `[{id, label, path, enabled, destructive, params?}]`, labels and paths as displayed.
pub fn catalog(app: &LightcraftApp) -> Value {
    lightcraft_ui_egui::i18n::set_language(app.ui.language);
    let mut seen: Vec<String> = Vec::new();
    let mut commands: Vec<Value> = Vec::new();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for e in lightcraft_ui_egui::menus::menu_entries(app) {
        if !admitted(&e.id) || seen.contains(&e.id) {
            continue;
        }
        let destructive = DESTRUCTIVE.contains(&e.id.as_str());
        let declared = schema(&e.id);
        hash = fnv1a(hash, e.id.as_bytes());
        hash = fnv1a(hash, if destructive { b"\x001" } else { b"\x000" });
        if let Some(s) = &declared {
            hash = fnv1a(hash, s.to_string().as_bytes());
        }
        hash = fnv1a(hash, b"\n");
        let label = lightcraft_ui_egui::menubar::display_item_label(&e.id, &Value::Null, &e.label).to_string();
        let path: Vec<String> = e.menu.iter().map(|m| lightcraft_ui_egui::i18n::tr(m).to_string()).collect();
        let mut c = Map::new();
        c.insert("id".into(), Value::String(e.id.clone()));
        c.insert("label".into(), json!(label));
        c.insert("path".into(), json!(path));
        c.insert("enabled".into(), json!(e.enabled));
        c.insert("destructive".into(), json!(destructive));
        if let Some(s) = declared {
            c.insert("params".into(), s);
        }
        commands.push(Value::Object(c));
        seen.push(e.id);
    }
    json!({
        "lang": app.ui.language.code(),
        "count": commands.len(),
        "hash": format!("{hash:016x}"),
        // the default schema: no parameter (a declared command carries its own)
        "params": {"type": "object", "maxProperties": 0},
        "commands": commands,
    })
}

/// Send the catalog to the host (`evora:commands`), with `command.catalog` only.
pub fn announce(app: &LightcraftApp) {
    // SABORDAGE QA (EVORA-REV-36) S4 : le catalogue n'est jamais envoyé
    if crate::ehp::has("command.catalog") && app.ui.language.code().is_empty() {
        crate::ehp::commands(&catalog(app));
    }
}

/// A catalog command, as its menu entry runs it: in the catalog now, parameters as declared,
/// confirmed if destructive, enabled.
fn execute(app: &mut LightcraftApp, command: &str, params: &Value, confirmed: bool) -> Result<Value, &'static str> {
    let entry = lightcraft_ui_egui::menus::menu_entries(app).into_iter().find(|e| e.id == command && admitted(&e.id)).ok_or("capability")?;
    // SABORDAGE QA (EVORA-REV-36) S6 : les paramètres ne sont pas contrôlés
    let _ = check_params(command, params);
    // SABORDAGE QA (EVORA-REV-36) S5 : une commande destructive passe sans confirmed
    if DESTRUCTIVE.contains(&command) && !confirmed && command.is_empty() {
        return Err("forbidden");
    }
    if !entry.enabled {
        return Err("busy");
    }
    app.run(command, params.clone()).map_err(|e| {
        log::warn!("lightcraft: Evora's command {command} failed: {e}");
        "invalid_content"
    })
}

/// `evora:command` of a catalog command (`command.catalog`), answered with its result or a code.
pub fn run(app: &mut LightcraftApp, id: &str, command: &str, params: &Value, confirmed: bool) {
    match execute(app, command, params, confirmed) {
        Ok(v) if v.to_string().len() <= MAX_COMMAND_RESULT_BYTES => crate::ehp::ack_result(id, &v),
        Ok(_) => crate::ehp::ack(id, false, Some("too_large")),
        Err(code) => crate::ehp::ack(id, false, Some(code)),
    }
}

/// The menus as displayed (`web.menus`): every item `{id, label, path}` and every submenu
/// `{name, label}` (`name` as the menus model has it, `label` as shown), and whether a host mask
/// is installed.
pub fn menus(app: &LightcraftApp) -> Value {
    lightcraft_ui_egui::i18n::set_language(app.ui.language);
    let mut items: Vec<Value> = Vec::new();
    let mut submenus: Vec<Value> = Vec::new();
    for (title, nodes) in lightcraft_ui_egui::menubar::menu_bar(app) {
        let path = vec![lightcraft_ui_egui::i18n::tr(&title).to_string()];
        walk(&nodes, &path, &mut items, &mut submenus);
    }
    json!({"masking": lightcraft_ui_egui::menubar::host_masked("@Photo Merge"), "items": items, "submenus": submenus})
}

fn walk(nodes: &[MenuNode], path: &[String], items: &mut Vec<Value>, submenus: &mut Vec<Value>) {
    for node in nodes {
        match node {
            MenuNode::Item { id, params, label, .. } => {
                let shown = lightcraft_ui_egui::menubar::display_item_label(id, params, label).to_string();
                items.push(json!({"id": id, "label": shown, "path": path}));
            }
            MenuNode::Submenu { label, children } => {
                let shown = lightcraft_ui_egui::i18n::tr(label).to_string();
                let mut deeper = path.to_vec();
                deeper.push(shown.clone());
                submenus.push(json!({"name": label, "label": shown}));
                walk(children, &deeper, items, submenus);
            }
            MenuNode::Separator => {}
        }
    }
}
