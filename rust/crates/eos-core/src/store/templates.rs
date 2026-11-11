//! The user's prompt templates: one markdown file each under
//! `<data folder>/templates` (`manager/services/UserTemplateService.ts`).

use eos_contracts::Template;

use crate::Error;

pub trait TemplateStore: Send + Sync + 'static {
    /// Every template, by name. A file that cannot be read is left out.
    fn list(&self) -> Result<Vec<Template>, Error>;
    fn exists(&self, name: &str) -> Result<bool, Error>;
    /// Creates or replaces a template. Attached files are copied into the
    /// template's own folder, so they outlive the place they came from.
    fn write(&self, template: &Template) -> Result<(), Error>;
    /// Moves the template (and its attached files) to `templates/.trash`;
    /// `false` when there is no such template.
    fn delete(&self, name: &str) -> Result<bool, Error>;
}
