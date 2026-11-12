//! What the shell can see of whether someone is at this computer. The server
//! turns it into "at the desktop or reach for the phone"
//! (`computeDesktopAttention` in `shared/notifications.ts`).
//!
//! Walking away produces no event at all, only the absence of input, so the
//! state is re-sampled on a slow timer as well as on window events.

/// Seconds since the last keyboard or mouse input anywhere on the machine.
pub fn idle_seconds() -> f64 {
    platform::idle_seconds()
}

/// Whether the screen is locked.
pub fn screen_locked() -> bool {
    platform::screen_locked()
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source_state: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDictionaryGetValue(dictionary: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFStringCreateWithCString(
            allocator: CFTypeRef,
            text: *const i8,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFBooleanGetValue(boolean: CFTypeRef) -> u8;
        fn CFRelease(value: CFTypeRef);
    }

    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = u32::MAX;
    const UTF8: u32 = 0x0800_0100;

    pub fn idle_seconds() -> f64 {
        // SAFETY: a pure query with plain-value arguments.
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) }
    }

    pub fn screen_locked() -> bool {
        // SAFETY: every object created here is released before returning, and
        // the dictionary's values are only read while it is retained.
        unsafe {
            let session = CGSessionCopyCurrentDictionary();
            if session.is_null() {
                return false;
            }
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                UTF8,
            );
            let value = CFDictionaryGetValue(session, key);
            let locked = !value.is_null() && CFBooleanGetValue(value) != 0;
            CFRelease(key);
            CFRelease(session);
            locked
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn idle_seconds() -> f64 {
        let mut info = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a correctly sized LASTINPUTINFO the call fills in.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return 0.0;
        }
        // SAFETY: a pure query.
        let now = unsafe { GetTickCount() };
        f64::from(now.wrapping_sub(info.dwTime)) / 1000.0
    }

    /// The input desktop cannot be opened while the secure lock screen owns it.
    pub fn screen_locked() -> bool {
        // SAFETY: the handle is closed when the call returns one.
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
            if desktop.is_null() {
                return true;
            }
            CloseDesktop(desktop);
            false
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::OnceLock;

    use zbus::Connection;
    use zbus::zvariant::Type;

    const SCREENSAVER: &str = "org.freedesktop.ScreenSaver";

    /// GNOME's idle monitor (X11 and Wayland), else the screensaver interface
    /// KDE and others implement. Compositors with neither (Hyprland, Sway) read
    /// as active, so there only a closed window hands notifications to the phone.
    pub fn idle_seconds() -> f64 {
        let monitor = "org.gnome.Mutter.IdleMonitor";
        call::<u64>(
            monitor,
            "/org/gnome/Mutter/IdleMonitor/Core",
            monitor,
            "GetIdletime",
        )
        .map(|milliseconds| milliseconds as f64 / 1000.0)
        .or_else(|| {
            call::<u32>(
                SCREENSAVER,
                "/org/freedesktop/ScreenSaver",
                SCREENSAVER,
                "GetSessionIdleTime",
            )
            .map(f64::from)
        })
        .unwrap_or(0.0)
    }

    pub fn screen_locked() -> bool {
        call::<bool>(
            SCREENSAVER,
            "/org/freedesktop/ScreenSaver",
            SCREENSAVER,
            "GetActive",
        )
        .unwrap_or(false)
    }

    fn call<T: for<'de> serde::Deserialize<'de> + Type>(
        destination: &str,
        path: &str,
        interface: &str,
        method: &str,
    ) -> Option<T> {
        static SESSION: OnceLock<Option<Connection>> = OnceLock::new();
        let session = SESSION
            .get_or_init(|| tauri::async_runtime::block_on(Connection::session()).ok())
            .as_ref()?;
        let reply = tauri::async_runtime::block_on(session.call_method(
            Some(destination),
            path,
            Some(interface),
            method,
            &(),
        ));
        reply.ok()?.body().deserialize::<T>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_without_failing() {
        let idle = idle_seconds();
        assert!(idle.is_finite() && idle >= 0.0);
        let _ = screen_locked();
    }
}
