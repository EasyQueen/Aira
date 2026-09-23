//! macOS native window configuration for cross-Space and fullscreen auxiliary display.

use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSColor, NSFloatingWindowLevel, NSWindow, NSWindowCollectionBehavior,
};
use tauri::{Manager, Runtime, WebviewWindow};

/// Configures macOS NSInitialToolTipDelay to 100ms for instantaneous tooltip hover display.
pub fn speed_up_tooltips() {
    let _ = std::process::Command::new("defaults")
        .args(["write", "com.sub2api.pet", "NSInitialToolTipDelay", "-int", "100"])
        .output();
}

/// Configures the transparent overlay window to join all macOS Desktop Spaces
/// and float over fullscreen applications.
pub fn configure_spaces_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_visible_on_all_workspaces(true);

    if let Some(_mtm) = MainThreadMarker::new() {
        apply_spaces_behavior(window);
    } else {
        let win = window.clone();
        let _ = window.app_handle().run_on_main_thread(move || {
            apply_spaces_behavior(&win);
        });
    }
}

fn apply_spaces_behavior<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_visible_on_all_workspaces(true);

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }

    let ns_win: &NSWindow = unsafe { &*(ptr as *mut NSWindow) };

    // 1. Configure level, opacity, background and deactivation behavior first
    ns_win.setLevel(NSFloatingWindowLevel);
    ns_win.setOpaque(false);
    ns_win.setBackgroundColor(Some(&NSColor::clearColor()));
    ns_win.setHidesOnDeactivate(false);

    // 2. Set collection behavior AFTER setting level/properties, because in Cocoa
    // changing window level or style can reset collectionBehavior back to default.
    // We intentionally omit `Stationary`: in macOS Sonoma/Sequoia, Stationary causes
    // WindowServer to pin the window to the current Space, defeating CanJoinAllSpaces.
    let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::IgnoresCycle;

    ns_win.setCollectionBehavior(behavior);
    ns_win.orderFrontRegardless();
}
