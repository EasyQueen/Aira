//! Native macOS Touch Bar showing the account-pool quota.
//!
//! macOS reflects the Touch Bar of the **frontmost app only**, so this is
//! visible whenever Sub2API Pet is the active app (e.g. after clicking the pet
//! or interacting with it). It is intentionally *not* an always-on widget —
//! that is an OS-level restriction, not something an accessory app can override.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSCustomTouchBarItem, NSSliderTouchBarItem, NSTextField, NSTouchBar,
};
use objc2_foundation::{NSArray, NSSet, NSString};
use tauri::{AppHandle, Runtime};

use super::{tray_counts, tray_overall_remaining, TrayMenuPayload};

/// Live references to the Touch Bar widgets. Kept in main-thread-only storage
/// (`NSTouchBar*` are `MainThreadOnly`, so they can't live in `Send` managed state).
struct TouchBarUi {
    /// Kept alive so the whole Touch Bar (template items + views) stays alive.
    _touch_bar: Retained<NSTouchBar>,
    quota_item: Retained<NSSliderTouchBarItem>,
    status_label: Retained<NSTextField>,
}

thread_local! {
    static TOUCH_BAR: RefCell<Option<TouchBarUi>> = const { RefCell::new(None) };
}

/// Build the Touch Bar and attach it to the app. Must run on the main thread.
pub(super) fn setup() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    // Quota gauge: label + read-only 0–100 slider.
    let quota_id = NSString::from_str("com.sub2api.pet.touchbar.quota");
    let quota_item =
        NSSliderTouchBarItem::initWithIdentifier(NSSliderTouchBarItem::alloc(mtm), &quota_id);
    {
        let slider = quota_item.slider();
        slider.setMinValue(0.0);
        slider.setMaxValue(100.0);
        slider.setDoubleValue(0.0);
        // The app drives the value; users can't drag a live quota gauge.
        slider.setEnabled(false);
    }
    quota_item.setLabel(Some(&NSString::from_str("额度 --%")));

    // Status text: online/abnormal counts.
    let status_id = NSString::from_str("com.sub2api.pet.touchbar.status");
    let status_item =
        NSCustomTouchBarItem::initWithIdentifier(NSCustomTouchBarItem::alloc(mtm), &status_id);
    let status_label = NSTextField::labelWithString(&NSString::from_str("Sub2API Pet"), mtm);
    status_item.setView(&status_label);

    let touch_bar = NSTouchBar::new(mtm);
    touch_bar.setDefaultItemIdentifiers(&NSArray::from_retained_slice(&[quota_id, status_id]));
    touch_bar.setTemplateItems(&NSSet::from_retained_slice(&[
        quota_item.clone().into_super(),
        status_item.into_super(),
    ]));

    // Show this Touch Bar whenever Sub2API Pet is the active app.
    NSApplication::sharedApplication(mtm).setTouchBar(Some(&touch_bar));

    TOUCH_BAR.with(|cell| {
        *cell.borrow_mut() = Some(TouchBarUi {
            _touch_bar: touch_bar,
            quota_item,
            status_label,
        });
    });
}

/// Push the latest quota onto the Touch Bar. May be called from any thread —
/// the actual AppKit mutation is dispatched to the main thread.
pub(super) fn apply<R: Runtime>(app: &AppHandle<R>, payload: &TrayMenuPayload) {
    let (total, online, abnormal) = tray_counts(payload);
    let overall = tray_overall_remaining(payload);

    let quota_text = match overall {
        Some(value) => {
            let pct = value.round().clamp(0.0, 100.0) as i64;
            if value <= 15.0 {
                format!("额度 {pct}% · 低")
            } else {
                format!("额度 {pct}%")
            }
        }
        None => "额度 --%".to_string(),
    };
    let quota_value = overall.unwrap_or(0.0).clamp(0.0, 100.0);

    let status_text = if payload.refreshing {
        "同步中…".to_string()
    } else if total == 0 {
        "暂无账号".to_string()
    } else {
        format!("在线 {online}/{total} · 异常 {abnormal}")
    };

    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        TOUCH_BAR.with(|cell| {
            let borrow = cell.borrow();
            let Some(ui) = borrow.as_ref() else {
                return;
            };
            ui.quota_item.setDoubleValue(quota_value);
            ui.quota_item.setLabel(Some(&NSString::from_str(&quota_text)));
            ui.status_label.setStringValue(&NSString::from_str(&status_text));
        });
    });
}
