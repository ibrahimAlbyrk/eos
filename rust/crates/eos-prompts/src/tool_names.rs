//! The tool names prompts may show (`manager/prompt-tool-names.ts`). A prompt
//! never spells a tool's name: it writes `{{SPAWN_WORKER_TOOL}}`, so a
//! renamed tool changes here and nowhere else. On the wire a name carries its
//! server's prefix (`mcp__orchestrator__…`, `mcp__worker__…`).

use serde_json::Value;

use crate::template::VariableScope;

/// Variable → the tool's own name. `LB` and `RB` are the literal braces: the
/// template language reads every `{{…}}` as a token, so a body that shows one
/// writes `{{LB}}path{{RB}}`.
pub const TOOL_NAME_VARS: &[(&str, &str)] = &[
    ("SPAWN_WORKER_TOOL", "spawn_worker"),
    ("LIST_ACTIVE_WORKERS_TOOL", "list_active_workers"),
    ("GET_WORKER_TOOL", "get_worker"),
    ("GET_WORKER_MESSAGES_TOOL", "get_worker_messages"),
    ("KILL_WORKER_TOOL", "kill_worker"),
    ("MESSAGE_WORKER_TOOL", "message_worker"),
    ("LIST_PENDING_PERMISSIONS_TOOL", "list_pending_permissions"),
    ("NOTIFY_USER_TOOL", "notify_user"),
    ("ASK_USER_TOOL", "ask_user"),
    ("SEND_MESSAGE_TO_PARENT_TOOL", "send_message_to_parent"),
    ("LIST_PEERS_TOOL", "list_peers"),
    ("ASK_PEER_TOOL", "ask_peer"),
    ("RESPOND_TO_PEER_TOOL", "respond_to_peer"),
    ("LIST_AVAILABLE_WORKERS_TOOL", "list_available_workers"),
    ("CREATE_WORKER_TOOL", "create_worker"),
    ("INTEGRATE_WORKERS_TOOL", "integrate_workers"),
    ("BROWSER_NAVIGATE_TOOL", "browser_navigate"),
    ("BROWSER_SNAPSHOT_TOOL", "browser_snapshot"),
    ("BROWSER_FIND_TOOL", "browser_find"),
    ("BROWSER_ACT_TOOL", "browser_act"),
    ("BROWSER_TYPE_TOOL", "browser_type"),
    ("BROWSER_FILL_FORM_TOOL", "browser_fill_form"),
    ("BROWSER_PRESS_TOOL", "browser_press"),
    ("BROWSER_SCROLL_TOOL", "browser_scroll"),
    ("BROWSER_WAIT_TOOL", "browser_wait"),
    ("BROWSER_GET_TOOL", "browser_get"),
    ("BROWSER_SCREENSHOT_TOOL", "browser_screenshot"),
    ("BROWSER_TABS_TOOL", "browser_tabs"),
    ("BROWSER_NEW_TAB_TOOL", "browser_new_tab"),
    ("BROWSER_CLOSE_TAB_TOOL", "browser_close_tab"),
    ("BROWSER_MUTE_TOOL", "browser_mute"),
    ("BROWSER_SHOW_TOOL", "browser_show"),
    ("LIST_PAGES_TOOL", "list_pages"),
    ("READ_PAGE_TOOL", "read_page"),
    ("CREATE_PAGE_TOOL", "create_page"),
    ("APPEND_TO_PAGE_TOOL", "append_to_page"),
    ("EDIT_PAGE_TOOL", "edit_page"),
    ("SET_PAGE_TASK_TOOL", "set_page_task"),
    ("SEARCH_MEMORY_TOOL", "search_memory"),
    ("SUGGEST_MEMORY_TOOL", "suggest_memory"),
    ("SEND_TO_MACHINE_TOOL", "send_to_machine"),
    ("PLUGIN_STATUS_TOOL", "plugin_status"),
    ("PLUGIN_PREVIEW_TOOL", "plugin_preview"),
    ("PRESENT_TOOL", "present"),
    ("PRESENT_APP_TOOL", "present_app"),
    ("FIND_PLACES_TOOL", "find_places"),
    ("CURRENT_LOCATION_TOOL", "current_location"),
    ("LB", "{{"),
    ("RB", "}}"),
];

/// The tool names as the globals every render shares.
pub fn tool_name_vars() -> VariableScope {
    TOOL_NAME_VARS.iter().map(|(name, value)| ((*name).to_owned(), Value::String((*value).to_owned()))).collect()
}
