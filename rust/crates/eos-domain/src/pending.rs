//! A permission ask waiting for the user's decision.

use eos_contracts::PendingPermissionRow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPermission {
    pub id: String,
    pub worker_id: String,
    pub tool_name: String,
    /// The tool's input, as the JSON text it was stored as.
    pub input: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub resolved: bool,
    /// `allow` or `deny`, once resolved.
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub tool_use_id: Option<String>,
    /// The input the user changed it to, as JSON text.
    pub updated_input: Option<String>,
}

impl PendingPermission {
    /// The row as clients read one ask.
    pub fn to_row(&self) -> PendingPermissionRow {
        PendingPermissionRow {
            tool_use_id: Some(self.tool_use_id.clone()),
            updated_input: Some(self.updated_input.clone()),
            ..self.to_list_row()
        }
    }

    /// The row as the list of open asks carries it: without the tool-use id
    /// and the changed input, as today.
    pub fn to_list_row(&self) -> PendingPermissionRow {
        PendingPermissionRow {
            id: self.id.clone(),
            worker_id: self.worker_id.clone(),
            tool_name: self.tool_name.clone(),
            input: self.input.clone(),
            created_at: self.created_at.into(),
            expires_at: self.expires_at.into(),
            resolved: i64::from(self.resolved).into(),
            decision: Some(self.decision.clone()),
            reason: Some(self.reason.clone()),
            tool_use_id: None,
            updated_input: None,
        }
    }
}
