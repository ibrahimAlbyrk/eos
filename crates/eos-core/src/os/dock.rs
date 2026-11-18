//! The app's icon in the Dock.

/// The number on the app's Dock icon.
pub trait DockBadge: Send + Sync + 'static {
    /// Shows `count` on the icon; `None` clears it.
    fn set(&self, count: Option<u32>);
}
