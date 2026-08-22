import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useUi } from "../../state/ui.jsx";
import { createHome, setHomeConfig, useHome } from "../../state/homeStore.js";
import { notify } from "../../lib/notify.js";
import { modelName, EFFORT_LABELS, effortChoicesFor } from "../../lib/models.js";
import { modelPickerLocked, workerBusy } from "../../lib/composerPickerLock.js";
import { AttachPopover } from "../code/popovers/AttachPopover.jsx";
import { ModelPopover } from "../code/popovers/ModelPopover.jsx";
import { EffortPopover } from "../code/popovers/EffortPopover.jsx";

// Beyond this the input scrolls instead of growing. Owned here (not in CSS) so
// the measured auto-grow and the cap can never disagree.
const MAX_INPUT_H = 240;

// Home's composer: one floating card per conversation — input, attach, the
// model/effort pickers (the Code composer's own popovers) and send. Unlike the
// Code composer it is not pane-scoped: it sends to a single Home conversation,
// or creates one from the first message.
export function HomeComposer({ conversationId, worker, live }) {
  const ui = useUi();
  const home = useHome();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);

  // Auto-grow: the card follows the text up to MAX_INPUT_H, then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_H) + "px";
  }, [text]);

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (conversationId) {
        await api.sendHomeMessage(conversationId, body, { queueWhenBusy: true });
      } else {
        await createHome(body);
      }
      setText("");
    } catch (e) {
      notify.error(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Picked files/folders ride along as absolute paths appended to the message —
  // the Home agent has the file tools to open them. (The Code composer's inline
  // [label] chips belong to its contentEditable editor, not this textarea.)
  const onAttach = (items) => {
    const paths = items.map((it) => it.path).filter(Boolean);
    if (paths.length === 0) return;
    setText((t) => (t && !/\s$/.test(t) ? t + " " : t) + paths.join(" ") + " ");
    inputRef.current?.focus();
  };

  const toggle = (id, e) => {
    e.stopPropagation();
    if (ui.openPopover === id) ui.closeAllPops();
    else ui.openPop(id);
  };

  // A live conversation's worker row owns its model/effort; before the first
  // send the store's pre-spawn config does (and flows into api.spawnHome).
  const config = { model: home.model, effort: home.effort };
  const model = worker?.model ?? config.model;
  const effort = worker?.effort ?? config.effort;
  const modelLocked = modelPickerLocked(worker);
  // While the agent is mid-turn and nothing is typed, send becomes the only
  // interrupt control Home has (there is no pane header to stop from).
  const showStop = workerBusy(worker) && !text.trim();

  return (
    <div className="home-dock">
      <div className="home-composer">
        <textarea
          ref={inputRef}
          className="home-composer__input"
          rows={1}
          value={text}
          placeholder="Write a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <div className="home-composer__controls">
          <div className="home-composer__group">
            <div className="home-ctl-wrap">
              <button
                className={"home-ctl home-ctl--icon" + (ui.openPopover === "attach" ? " open" : "")}
                title="Attach files"
                aria-label="Attach files"
                onClick={(e) => toggle("attach", e)}
                data-popover-trigger="attach"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
              <AttachPopover onAttach={onAttach} />
            </div>
          </div>
          <div className="home-composer__group">
            <div className="home-ctl-wrap">
              <button
                className={"home-ctl" + (ui.openPopover === "model" ? " open" : "")}
                disabled={modelLocked}
                title={modelLocked ? "Model switch needs the agent idle" : "Model"}
                onClick={(e) => toggle("model", e)}
                data-popover-trigger="model"
              >
                {modelName(model) || model}
              </button>
              <ModelPopover
                live={live}
                worker={worker}
                config={config}
                onPick={(id) => setHomeConfig({ model: id })}
              />
            </div>
            {effortChoicesFor(model).length > 0 && (
              <div className="home-ctl-wrap">
                <button
                  className={"home-ctl home-ctl--dim"
                    + (effort === "ultracode" ? " home-ctl--ultra" : "")
                    + (ui.openPopover === "effort" ? " open" : "")}
                  title="Effort"
                  onClick={(e) => toggle("effort", e)}
                  data-popover-trigger="effort"
                >
                  {EFFORT_LABELS[effort] ?? "High"}
                </button>
                <EffortPopover
                  live={live}
                  worker={worker}
                  config={config}
                  onPick={(id) => setHomeConfig({ effort: id })}
                />
              </div>
            )}
            <button
              className={"home-send" + (showStop ? " is-stop" : "")}
              onClick={showStop ? () => live.interruptAgent(worker.id) : submit}
              disabled={!showStop && (!text.trim() || sending)}
              title={showStop ? "Stop" : "Send"}
              aria-label={showStop ? "Stop" : "Send"}
            >
              {showStop ? (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="2" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      <div className="home-dock__note">AI can make mistakes — double-check important responses.</div>
    </div>
  );
}
