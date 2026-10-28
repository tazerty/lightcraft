//! Evora (EVORA-REV-29): two keys of the engine's window belong to the host under the bridge.
//!
//! - **F6** without a modifier (capability `ui.focus-out`, amendment A-19 of Evora's HOST-PROTOCOL
//!   §7.9): the egui canvas takes the focus and consumes Tab, Shift+Tab and Escape, so without a way
//!   out the editor would trap the keyboard (WCAG 2.1.2). In mode B the host cannot listen inside
//!   the engine's document: the engine sends `evora:focus-out {}` and the host moves the focus to
//!   « Leave the editor ». F6 is the host's own exit key in mode A (Q-15-13), the same key here.
//! - **Ctrl+S** or **Cmd+S** (capability `doc.save`): the photo shown is saved to Evora's Drive
//!   (`evora:save`, [`crate::host_docs`]) instead of the engine's own Save Metadata to File, which
//!   would write a sidecar in the page's memory, or the browser's « Save page ».
//!
//! Both are held back from the canvas and the browser in the capture phase of the window, before
//! any other listener of the page; a held key acts once. Without the capability, the key is left
//! alone. The event is read by name (`key`, modifiers, `repeat`), with no extra web-sys feature.

use wasm_bindgen::prelude::*;
use wasm_bindgen::{JsCast, JsValue};

use crate::ehp::HostEvent;

/// The key that hands the keyboard back to the host.
const EXIT_KEY: &str = "F6";

/// Listen for the host's keys on the engine's window, in the capture phase (once per page).
pub fn listen(window: &web_sys::Window) {
    let on_key = Closure::<dyn FnMut(web_sys::Event)>::new(|e: web_sys::Event| {
        let v: &JsValue = e.as_ref();
        let key = js_sys::Reflect::get(v, &"key".into()).ok().and_then(|k| k.as_string()).unwrap_or_default();
        let flag = |name: &str| js_sys::Reflect::get(v, &name.into()).ok().and_then(|f| f.as_bool()) == Some(true);
        let (alt, ctrl, meta, shift) = (flag("altKey"), flag("ctrlKey"), flag("metaKey"), flag("shiftKey"));
        let once = e.type_() == "keydown" && !flag("repeat");
        if key == EXIT_KEY && !(alt || ctrl || meta || shift) && crate::ehp::has("ui.focus-out") {
            e.prevent_default();
            e.stop_immediate_propagation();
            if once {
                crate::ehp::focus_out();
            }
        // SABORDAGE QA (EVORA-REV-36) S8 : Ctrl+S est laissé au canevas
        } else if key.eq_ignore_ascii_case("s") && (ctrl || meta) && !alt && !shift && crate::ehp::has("doc.save") && key.is_empty() {
            e.prevent_default();
            e.stop_immediate_propagation();
            if once {
                crate::ehp::push_event(HostEvent::SaveShortcut);
            }
        }
    });
    let listener: &js_sys::Function = on_key.as_ref().unchecked_ref();
    let down = window.add_event_listener_with_callback_and_bool("keydown", listener, true).is_ok();
    let up = window.add_event_listener_with_callback_and_bool("keyup", listener, true).is_ok();
    if down || up {
        // the listener lives as long as the page
        on_key.forget();
    } else {
        log::warn!("lightcraft: the host's keys (F6, Ctrl+S) could not be listened for");
    }
}
