//! Strings shown by the Rust side (tray menu). The WebView has its own
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
