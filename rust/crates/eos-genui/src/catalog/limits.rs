//! Enums, limits and name rules of a visual answer.

use crate::re::pattern;

pub const GENUI_TONES: &[&str] = &["blue", "green", "amber", "red", "violet", "teal"];

/// The icons the kit draws (lucide names).
#[rustfmt::skip]
pub const GENUI_ICONS: &[&str] = &[
    "utensils", "map", "map-pin", "calendar", "clock", "star", "flask", "git-branch", "chart", "list",
    "check", "alert-triangle", "info", "lightbulb", "book", "plane", "car", "train", "hotel", "coffee",
    "wine", "shopping-bag", "wallet", "user", "users", "file", "folder", "code", "terminal", "bug",
    "rocket", "heart", "sun", "cloud", "music", "film", "globe", "link", "search", "sparkles",
];

/// Sizes are bytes of UTF-8; `*_chars` count UTF-16 code units, as the dashboard does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenuiLimits {
    pub title_chars: usize,
    pub summary_chars: usize,
    pub ui_bytes: usize,
    pub data_bytes: usize,
    pub depth: usize,
    pub carousel_min: usize,
    pub carousel_max: usize,
    pub maps: usize,
    pub images: usize,
    pub primary_actions: usize,
    pub action_label_chars: usize,
    pub state_bytes: usize,
    pub app_html_bytes: usize,
    pub app_height_min: usize,
    pub app_height_max: usize,
    pub tabs_min: usize,
    pub tabs_max: usize,
}

pub const GENUI_LIMITS: GenuiLimits = GenuiLimits {
    title_chars: 80,
    summary_chars: 600,
    ui_bytes: 24 * 1024,
    data_bytes: 64 * 1024,
    depth: 8,
    carousel_min: 3,
    carousel_max: 8,
    maps: 1,
    images: 40,
    primary_actions: 2,
    action_label_chars: 60,
    state_bytes: 32 * 1024,
    app_html_bytes: 256 * 1024,
    app_height_min: 200,
    app_height_max: 720,
    tabs_min: 2,
    tabs_max: 6,
};

pub const ENTITY_TYPES: &[&str] = &["Place", "Product", "Event", "Person", "Article", "Media", "File", "Generic"];
pub const ACTION_KINDS: &[&str] = &["send", "prefill", "open", "copy", "set"];
pub const PRESENT_KEYS: &[&str] = &["title", "tone", "icon", "replaces", "data", "actions", "ui", "summary"];

// Names the expression language reserves for its scopes.
pub(crate) const RESERVED_DATA_KEYS: &[&str] = &["item", "state", "data", "true", "false", "null"];

pattern!(
    /// Collection, action and state names: identifiers (any script).
    NAME_RE, r"^[\p{L}_][\p{L}\p{N}_-]{0,39}$", "u"
);
pattern!(STATE_KEY_RE, r"^[\p{L}_][\p{L}\p{N}_]{0,39}$", "u");
pattern!(FIELD_RE, r"^[\p{L}_$][\p{L}\p{N}_$]*(\.[\p{L}_$][\p{L}\p{N}_$]*)*$", "u");
pattern!(IDENT_RE, r"^[\p{L}_$][\p{L}\p{N}_$]*$", "u");
pattern!(SORT_RE, r"^-?\s*[\p{L}_$][\p{L}\p{N}_$.]*$", "u");
pattern!(
    /// The id of a rendered view: v_ + 12 base62 characters.
    VIEW_ID_RE, r"^v_[A-Za-z0-9]{12}$", ""
);
pattern!(URL_RE, r"^https?:\/\/\S+$", "i");
pattern!(SITE_RE, r"^(https?:\/\/)?[\p{L}\p{N}.-]+\.[\p{L}]{2,}(:\d+)?(\/\S*)?$", "iu");
pattern!(HREF_OK, r"^(https?:\/\/|maps:|mailto:|tel:|file:\/\/|\/|~\/|\{)", "i");
pattern!(STATE_HOLE_RE, r"\{\s*state\.([\p{L}_][\p{L}\p{N}_]*)", "u");

/// Whether `name` can name a data collection, an action or a `set` key.
pub fn is_genui_name(name: &str) -> bool {
    crate::re::is_match(&NAME_RE, name)
}

/// Whether `key` can be a state key (`bind=`).
pub fn is_state_key(key: &str) -> bool {
    crate::re::is_match(&STATE_KEY_RE, key)
}

pub(crate) fn is_entity_type(v: &crate::Value) -> bool {
    v.as_str().is_some_and(|s| ENTITY_TYPES.contains(&s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        for re in [
            &NAME_RE,
            &STATE_KEY_RE,
            &FIELD_RE,
            &IDENT_RE,
            &SORT_RE,
            &VIEW_ID_RE,
            &URL_RE,
            &SITE_RE,
            &HREF_OK,
            &STATE_HOLE_RE,
        ] {
            assert!(!crate::re::is_match(re, "\u{0}"));
        }
        assert!(is_genui_name("mekân_2"));
        assert!(!is_genui_name("2nd"));
        assert!(!is_state_key("party-size"));
    }
}
