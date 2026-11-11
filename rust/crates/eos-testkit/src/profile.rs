use eos_core::prompt::{MemorySnapshot, ProfileRenderer, ProfileText};

/// A profile renderer that answers one fixed text, whatever the session.
#[derive(Debug, Clone)]
pub struct FakeProfileRenderer {
    text: String,
    empty: bool,
}

impl FakeProfileRenderer {
    /// A user with a profile that renders as `text`.
    pub fn with_text(text: impl Into<String>) -> Self {
        Self { text: text.into(), empty: false }
    }

    /// A user who has told Eos nothing: `text` is the stock block.
    pub fn stock(text: impl Into<String>) -> Self {
        Self { text: text.into(), empty: true }
    }
}

impl ProfileRenderer for FakeProfileRenderer {
    fn render(&self, _kind: &str, _project: Option<&str>, _memory: Option<&MemorySnapshot>) -> ProfileText {
        ProfileText { text: self.text.clone(), empty: self.empty }
    }
}
