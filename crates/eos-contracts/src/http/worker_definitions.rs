//! Wire types of the worker definitions routes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::validate::Validate;
use crate::worker_definition::{WorkerDefinition, WorkerDefinitionSource};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CreateWorkerResponse {
    pub name: String,
}

impl Validate for CreateWorkerResponse {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefinitionCatalogEntry {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub source: WorkerDefinitionSource,
}

impl Validate for WorkerDefinitionCatalogEntry {}

pub type WorkerDefinitionListResponse = Vec<WorkerDefinitionCatalogEntry>;

/// `POST /worker-definitions` takes a definition as it is written in a file.
pub type CreateWorkerRequest = WorkerDefinition;
