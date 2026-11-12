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
    pub editor: &'static str,
    pub settings: &'static str,
    pub quit: &'static str,
}

pub const fn tray_text(lang: Lang) -> TrayText {
    match lang {
        Lang::En => TrayText {
            tooltip: "Cropa screenshot",
            capture: "Capture region",
            editor: "Open editor",
            settings: "Settings",
            quit: "Quit Cropa",
        },
        Lang::Vi => TrayText {
            tooltip: "Cropa screenshot",
            capture: "Chụp vùng",
            editor: "Mở editor",
            settings: "Cài đặt",
            quit: "Thoát Cropa",
        },
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
