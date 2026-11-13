//! Strings shown by the Rust side (tray menu, native dialogs). The WebView has its own
//! i18next catalogue in `src/lib/i18n`; keep the two languages in step.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Vi,
}

impl Lang {
    /// Pick a language from a BCP 47 tag such as `vi-VN` or `en-US`.
    pub fn from_tag(tag: &str) -> Self {
        let primary = tag.split(['-', '_']).next().unwrap_or_default();
        if primary.eq_ignore_ascii_case("vi") {
            Self::Vi
        } else {
            Self::En
        }
    }

    pub fn detect() -> Self {
        sys_locale::get_locale().map_or(Self::En, |tag| Self::from_tag(&tag))
    }
}

pub struct TrayText {
    pub tooltip: &'static str,
    pub capture: &'static str,
    pub history: &'static str,
    pub editor: &'static str,
    pub quit: &'static str,
}

pub const fn tray_text(lang: Lang) -> TrayText {
    match lang {
        Lang::En => TrayText {
            tooltip: "Cropa screenshot",
            capture: "Capture region",
            history: "History",
            editor: "Open editor",
            quit: "Quit Cropa",
        },
        Lang::Vi => TrayText {
            tooltip: "Cropa screenshot",
            capture: "Chụp vùng",
            history: "Lịch sử",
            editor: "Mở editor",
            quit: "Thoát Cropa",
        },
    }
}

/// Title of the welcome window.
pub const fn onboarding_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Welcome to Cropa",
        Lang::Vi => "Chào mừng đến với Cropa",
    }
}

pub struct FirstRunText {
    pub title: &'static str,
    pub question: &'static str,
}

pub const fn first_run_text(lang: Lang) -> FirstRunText {
    match lang {
        Lang::En => FirstRunText {
            title: "Cropa",
            question: "Start Cropa with Windows?\n\nCropa waits in the tray after you sign in, so the capture key works right away. You can change this later in Settings.",
        },
        Lang::Vi => FirstRunText {
            title: "Cropa",
            question: "Khởi động Cropa cùng Windows?\n\nCropa sẽ chờ sẵn ở khay hệ thống sau khi bạn đăng nhập, để phím chụp dùng được ngay. Bạn có thể đổi lại sau trong Cài đặt.",
        },
    }
}

/// The notice shown when Windows refuses the start-with-Windows change.
pub fn autostart_failed_text(lang: Lang, enabled: bool, detail: &str) -> String {
    match (lang, enabled) {
        (Lang::En, true) => format!(
            "Cropa couldn't turn on start with Windows.\n\nWindows refused the change ({detail}).\n\nYou can change it later in Cropa Settings."
        ),
        (Lang::En, false) => format!(
            "Cropa couldn't turn off start with Windows.\n\nWindows refused the change ({detail}).\n\nYou can change it later in Cropa Settings."
        ),
        (Lang::Vi, true) => format!(
            "Cropa không bật được khởi động cùng Windows.\n\nWindows từ chối thay đổi ({detail}).\n\nBạn có thể đổi lại sau trong Cài đặt của Cropa."
        ),
        (Lang::Vi, false) => format!(
            "Cropa không tắt được khởi động cùng Windows.\n\nWindows từ chối thay đổi ({detail}).\n\nBạn có thể đổi lại sau trong Cài đặt của Cropa."
        ),
    }
}

pub struct CaptureText {
    pub title: &'static str,
    /// The hint for region mode.
    pub hint: &'static str,
    pub region: &'static str,
    pub window: &'static str,
    pub full_screen: &'static str,
    pub cancel: &'static str,
    pub window_hint: &'static str,
    pub full_screen_hint: &'static str,
    pub keys_hint: &'static str,
}

pub const fn capture_text(lang: Lang) -> CaptureText {
    match lang {
        Lang::En => CaptureText {
            title: "Cropa",
            hint: "Drag to capture · Esc to cancel",
            region: "Region",
            window: "Window",
            full_screen: "Full screen",
            cancel: "Cancel",
            window_hint: "Click a window to capture · Esc to cancel",
            full_screen_hint: "Click a screen to capture it · Esc to cancel",
            keys_hint: "R, W, F switch mode",
        },
        Lang::Vi => CaptureText {
            title: "Cropa",
            hint: "Kéo để chụp · Esc để hủy",
            region: "Vùng",
            window: "Cửa sổ",
            full_screen: "Toàn màn hình",
            cancel: "Hủy",
            window_hint: "Bấm vào một cửa sổ để chụp · Esc để hủy",
            full_screen_hint: "Bấm vào một màn hình để chụp · Esc để hủy",
            keys_hint: "R, W, F để đổi chế độ",
        },
    }
}

pub struct PreviewText {
    /// The window's name, read out by screen readers.
    pub title: &'static str,
    pub edit: &'static str,
}

pub const fn preview_text(lang: Lang) -> PreviewText {
    match lang {
        Lang::En => PreviewText {
            title: "Cropa preview",
            edit: "Edit",
        },
        Lang::Vi => PreviewText {
            title: "Xem trước Cropa",
            edit: "Sửa",
        },
    }
}

pub struct SaveDialogText {
    pub pick_folder_title: &'static str,
    pub save_as_title: &'static str,
    pub preset_title: &'static str,
    pub preset_file: &'static str,
    pub png: &'static str,
    pub jpeg: &'static str,
    pub webp: &'static str,
}

pub const fn save_dialog_text(lang: Lang) -> SaveDialogText {
    match lang {
        Lang::En => SaveDialogText {
            pick_folder_title: "Choose a folder for your Cropa images",
            save_as_title: "Save image as",
            preset_title: "Export preset",
            preset_file: "Cropa preset",
            png: "PNG image",
            jpeg: "JPEG image",
            webp: "WebP image",
        },
        Lang::Vi => SaveDialogText {
            pick_folder_title: "Chọn thư mục lưu ảnh Cropa",
            save_as_title: "Lưu ảnh thành",
            preset_title: "Xuất preset",
            preset_file: "Preset Cropa",
            png: "Ảnh PNG",
            jpeg: "Ảnh JPEG",
            webp: "Ảnh WebP",
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureFailure {
    Capture,
    Overlay,
    Clipboard,
}

/// The notice shown when a capture fails: what happened, why, what to do.
pub fn capture_failed_text(lang: Lang, failure: CaptureFailure, detail: &str) -> String {
    match (lang, failure) {
        (Lang::En, CaptureFailure::Capture) => format!(
            "Cropa couldn't capture the screen.\n\nWindows refused the screen capture ({detail}).\n\nTry again. If it keeps failing, restart Cropa."
        ),
        (Lang::En, CaptureFailure::Overlay) => format!(
            "Cropa couldn't open the region selection.\n\nWindows refused to show it ({detail}).\n\nTry again. If it keeps failing, restart Cropa."
        ),
        (Lang::En, CaptureFailure::Clipboard) => format!(
            "Cropa couldn't copy the capture.\n\nAnother app may be holding the clipboard ({detail}).\n\nClose that app or try the capture again."
        ),
        (Lang::Vi, CaptureFailure::Capture) => format!(
            "Cropa không chụp được màn hình.\n\nWindows từ chối việc chụp màn hình ({detail}).\n\nHãy thử lại. Nếu vẫn lỗi, hãy khởi động lại Cropa."
        ),
        (Lang::Vi, CaptureFailure::Overlay) => format!(
            "Cropa không mở được màn chọn vùng.\n\nWindows từ chối hiển thị nó ({detail}).\n\nHãy thử lại. Nếu vẫn lỗi, hãy khởi động lại Cropa."
        ),
        (Lang::Vi, CaptureFailure::Clipboard) => format!(
            "Cropa không sao chép được ảnh chụp.\n\nCó thể một ứng dụng khác đang giữ clipboard ({detail}).\n\nHãy đóng ứng dụng đó hoặc chụp lại."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::Lang;

    #[test]
    fn vietnamese_tags() {
        assert_eq!(Lang::from_tag("vi"), Lang::Vi);
        assert_eq!(Lang::from_tag("vi-VN"), Lang::Vi);
        assert_eq!(Lang::from_tag("VI_vn"), Lang::Vi);
    }

    #[test]
    fn everything_else_is_english() {
        assert_eq!(Lang::from_tag("en-US"), Lang::En);
        assert_eq!(Lang::from_tag("fr-FR"), Lang::En);
        assert_eq!(Lang::from_tag(""), Lang::En);
    }
}
