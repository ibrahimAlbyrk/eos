//! Fakes of the ports that reach outside the process.

use eos_contracts::CatalogModel;
use eos_core::agent::ModelCatalog;

/// A model catalog with a fixed list: windows come from it, else from the
/// built-in baseline, exactly as the real catalog answers.
#[derive(Debug, Default)]
pub struct FakeModelCatalog {
    pub models: Vec<CatalogModel>,
}

impl ModelCatalog for FakeModelCatalog {
    fn models(&self) -> Vec<CatalogModel> {
        self.models.clone()
    }

    fn context_window_for(&self, model: Option<&str>) -> i64 {
        eos_domain::model::context_window_for(&self.models, model)
    }
}
