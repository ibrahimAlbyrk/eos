use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::de;
use crate::validate::{Issues, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionState {
    SignedOut,
    SignedIn,
    Expired,
}

impl Validate for SubscriptionState {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BillingRoute {
    Subscription,
    ApiKey,
    Blocked,
    None,
}

impl Validate for BillingRoute {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AccountSubscription {
    pub supported: bool,
    pub state: SubscriptionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AccountSubscriptionSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

impl Validate for AccountSubscription {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AccountSubscriptionSource {
    Eos,
}

impl Validate for AccountSubscriptionSource {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanLogin {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub state: SubscriptionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limited_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_use: Option<i64>,
}

impl Validate for PlanLogin {
    fn validate(&self, cx: &mut Issues) {
        cx.at("inUse", |cx| {
            if let Some(v) = &self.in_use {
                cx.int_min(*v, 0, false);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub id: String,
    pub label: String,
    #[serde(deserialize_with = "de::required")]
    pub subscription: Option<AccountSubscription>,
    pub api_key: AccountStatusApiKey,
    pub route: BillingRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logins: Option<Vec<PlanLogin>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_login_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_switch: Option<bool>,
}

impl Validate for AccountStatus {
    fn validate(&self, cx: &mut Issues) {
        cx.at("logins", |cx| {
            if let Some(v) = &self.logins {
                v.validate(cx);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AccountStatusApiKey {
    pub set: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Validate for AccountStatusApiKey {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AccountsResponse {
    pub accounts: Vec<AccountStatus>,
}

impl Validate for AccountsResponse {
    fn validate(&self, cx: &mut Issues) {
        cx.at("accounts", |cx| self.accounts.validate(cx));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SignInState {
    Starting,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
}

impl Validate for SignInState {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignInSession {
    pub id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_id: Option<String>,
    pub state: SignInState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_entry: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Validate for SignInSession {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SignInCodeRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub code: String,
}

impl Validate for SignInCodeRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("code", |cx| {
            cx.str_min(&self.code, 1);
            cx.str_max(&self.code, 4096);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignInStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_id: Option<String>,
}

impl Validate for SignInStartRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("loginId", |cx| {
            if let Some(v) = &self.login_id {
                cx.str_min(v, 1);
                cx.str_max(v, 64);
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanLoginRenameRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub label: String,
}

impl Validate for PlanLoginRenameRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("label", |cx| {
            cx.str_min(&self.label, 1);
            cx.str_max(&self.label, 60);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultLoginRequest {
    pub login_id: String,
}

impl Validate for DefaultLoginRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("loginId", |cx| {
            cx.str_min(&self.login_id, 1);
            cx.str_max(&self.login_id, 64);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutoSwitchRequest {
    pub enabled: bool,
}

impl Validate for AutoSwitchRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanResumeRequest {
    pub row_id: i64,
    pub on: bool,
}

impl Validate for PlanResumeRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("rowId", |cx| cx.int_min(self.row_id, 0, false));
    }
}
