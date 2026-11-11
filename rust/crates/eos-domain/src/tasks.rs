//! A worker's task list, folded from the task tools its agent calls
//! (`core/src/domain/tasks.ts`).

use eos_contracts::{Task, TaskStatus, UnknownRecord};
use serde_json::Value;

/// The list stored on a worker row; anything unreadable is an empty list,
/// entries that are not tasks are dropped.
pub fn parse_stored_tasks(json: Option<&str>) -> Vec<Task> {
    let Some(Ok(Value::Array(items))) = json.map(serde_json::from_str::<Value>) else { return Vec::new() };
    items.into_iter().filter_map(|t| serde_json::from_value(t).ok()).collect()
}

fn status(value: Option<&Value>) -> Option<TaskStatus> {
    serde_json::from_value(value?.clone()).ok()
}

/// The list after a call of tool `name`; `None` when the tool is not a task
/// tool (or its input makes no list).
pub fn apply_task_tool(prev: &[Task], name: &str, input: &UnknownRecord) -> Option<Vec<Task>> {
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    match name {
        "TodoWrite" => {
            let todos = input.get("todos")?.as_array()?;
            Some(todos.iter().filter_map(|t| serde_json::from_value(t.clone()).ok()).collect())
        }
        "TaskCreate" => {
            let mut next = prev.to_vec();
            if let Some(subject) = text("subject") {
                next.push(Task {
                    content: subject,
                    status: TaskStatus::Pending,
                    active_form: text("activeForm").map(Some),
                    deleted: None,
                });
            }
            Some(next)
        }
        "TaskUpdate" => {
            let mut next = prev.to_vec();
            // Task ids are positions, counted from one; the tool takes them as text or numbers.
            let id = match input.get("taskId") {
                Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
                Some(Value::Number(n)) => n.as_f64(),
                _ => None,
            };
            let index = id.filter(|n| n.fract() == 0.0 && *n >= 1.0).map(|n| n as usize - 1);
            if let Some(task) = index.and_then(|i| next.get_mut(i)) {
                if input.get("status").and_then(Value::as_str) == Some("deleted") {
                    task.deleted = Some(true);
                } else if let Some(status) = status(input.get("status")) {
                    task.status = status;
                }
                if let Some(subject) = text("subject") {
                    task.content = subject;
                }
                if let Some(active) = text("activeForm") {
                    task.active_form = Some(Some(active));
                }
            }
            Some(next)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(value: Value) -> UnknownRecord {
        serde_json::from_value(value).expect("an object")
    }

    // core/src/__tests__/tasks.test.ts
    #[test]
    fn task_tools_build_and_change_the_list() {
        let none: Vec<Task> = Vec::new();
        assert_eq!(apply_task_tool(&none, "Read", &input(json!({}))), None);
        let one = apply_task_tool(
            &none,
            "TaskCreate",
            &input(json!({"subject": "Write tests", "activeForm": "Writing tests"})),
        )
        .expect("a list");
        let two = apply_task_tool(&one, "TaskCreate", &input(json!({"subject": "Ship"}))).expect("a list");
        assert_eq!((two.len(), two[0].content.as_str(), two[0].status), (2, "Write tests", TaskStatus::Pending));
        assert_eq!(two[0].active_form, Some(Some("Writing tests".into())));

        let moved = apply_task_tool(&two, "TaskUpdate", &input(json!({"taskId": "1", "status": "in_progress"})))
            .expect("a list");
        assert_eq!(moved[0].status, TaskStatus::InProgress);
        let gone =
            apply_task_tool(&moved, "TaskUpdate", &input(json!({"taskId": 2, "status": "deleted"}))).expect("a list");
        assert_eq!((gone[1].deleted, gone[1].status), (Some(true), TaskStatus::Pending));
        let same = apply_task_tool(&gone, "TaskUpdate", &input(json!({"taskId": "9", "status": "completed"})))
            .expect("a list");
        assert_eq!(same, gone, "an unknown task changes nothing");

        let written = apply_task_tool(
            &gone,
            "TodoWrite",
            &input(json!({"todos": [{"content": "a", "status": "completed"}, {"content": 5}, {"content": "b", "status": "pending"}]})),
        )
        .expect("a list");
        assert_eq!(written.iter().map(|t| t.content.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(apply_task_tool(&gone, "TodoWrite", &input(json!({"todos": "no"}))), None);
    }

    #[test]
    fn a_stored_list_survives_garbage() {
        let stored = r#"[{"content":"a","status":"pending"},{"nope":1}]"#;
        assert_eq!(parse_stored_tasks(Some(stored)).len(), 1);
        assert!(parse_stored_tasks(Some("{not json")).is_empty());
        assert!(parse_stored_tasks(None).is_empty());
    }
}
