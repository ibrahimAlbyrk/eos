use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::primitives::de;
use crate::validate::{Issues, Validate};

pub const SIDE_QUESTION_MAX_CHARS: i64 = 4000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SideQuestionRequest {
    #[serde(deserialize_with = "de::trimmed")]
    pub question: String,
}

impl Validate for SideQuestionRequest {
    fn validate(&self, cx: &mut Issues) {
        cx.at("question", |cx| {
            cx.str_min(&self.question, 1);
            cx.str_max(&self.question, 4000);
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SideQuestionAnswer {
    pub answer: String,
}
