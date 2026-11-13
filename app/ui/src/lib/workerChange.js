// The agent's own output — a logged agent event, its context size — arrives
// many times a turn and moves nothing but the transcript. Any other worker
// change may move what the views around it show (the message queue, a try).
const OUTPUT_TYPES = new Set(["agent_event", "context"]);

export function isWorkerStateChange(topic, payload) {
  return typeof topic === "string" && topic.startsWith("worker:") && !OUTPUT_TYPES.has(payload?.type);
}
