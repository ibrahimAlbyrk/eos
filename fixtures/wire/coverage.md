# Wire coverage

Written by `wire-recorder coverage`. Do not edit by hand.

- Registered routes: **314**
  - a success answer recorded: **208**
  - only refusals and errors recorded: **100**
  - not recorded: **6**
  - without a recorded success and without a reason: **0**
- `ROUTES` keys: **270**, with a success recorded for at least one method: **183**
- Recorded steps: **1089**

## Registered routes

In registration order (the router takes the first match).

| route | reach from outside | steps | result | why no success |
|---|---|---|---|---|
| `GET /h/:hostId/*` | local-only | 4 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /h/:hostId/*` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `PUT /h/:hostId/*` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `DELETE /h/:hostId/*` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `HEAD /h/:hostId/*` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `GET /health` | phone READ | 16 | recorded |  |
| `GET /api/host` | peer-open | 3 | recorded |  |
| `GET /api/peer` | local-only | 4 | recorded |  |
| `PUT /api/peer` | local-only | 3 | recorded |  |
| `POST /api/peer/invite` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `DELETE /api/peer/invite` | local-only | 2 | recorded |  |
| `DELETE /api/peer/devices/:fp` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/peer/devices/:fp/disconnect` | local-only | 2 | recorded |  |
| `GET /api/hosts` | local-only | 4 | recorded |  |
| `POST /api/hosts` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `PUT /api/hosts/:fp` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `DELETE /api/hosts/:fp` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/hosts/:fp/view-token` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/hosts/:fp/reconnect` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `GET /ui/plugins/:id/:rev.:ext` | peer-open | 2 | errors only | Needs the dashboard bundle (app/ui/dist) or a plugin with a built UI; the recording daemon runs from source without them. |
| `GET /ui/*` | peer-open | 2 | errors only | Needs the dashboard bundle (app/ui/dist) or a plugin with a built UI; the recording daemon runs from source without them. |
| `GET /stream` |  | 20 | recorded |  |
| `POST /stream/focus` |  | 7 | recorded |  |
| `GET /api/ui-config` | phone READ | 3 | recorded |  |
| `POST /api/model-catalog/refresh` |  | 0 | not recorded | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/backends/:name/models` | phone READ | 3 | recorded |  |
| `GET /api/backends/presets` |  | 2 | recorded |  |
| `POST /api/backends` |  | 3 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `POST /api/backends/test` |  | 3 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `DELETE /api/backends/:name` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `GET /metrics` |  | 3 | recorded |  |
| `GET /datetime` |  | 2 | recorded |  |
| `GET /pick-directory` | local-only | 0 | not recorded | Opens a dialog, an app or a Finder action on the owner's screen. |
| `GET /pick-file` | local-only | 0 | not recorded | Opens a dialog, an app or a Finder action on the owner's screen. |
| `GET /fs/default-app` | phone READ | 3 | recorded |  |
| `POST /fs/open` | phone HIGH +token | 3 | errors only | Opens a dialog, an app or a Finder action on the owner's screen. |
| `POST /fs/reveal` | phone HIGH +token | 3 | errors only | Opens a dialog, an app or a Finder action on the owner's screen. |
| `POST /fs/open-in` |  | 3 | errors only | Opens a dialog, an app or a Finder action on the owner's screen. |
| `GET /fs/editors` |  | 2 | recorded |  |
| `GET /fs/image` | phone READ | 4 | recorded |  |
| `GET /fs/icon` | phone READ | 3 | recorded |  |
| `GET /fs/read` | phone READ | 7 | recorded |  |
| `GET /fs/list` | phone READ | 11 | recorded |  |
| `GET /fs/stat` | phone READ | 7 | recorded |  |
| `POST /fs/write` | phone HIGH +token | 8 | recorded |  |
| `POST /fs/paste` | phone HIGH +token | 4 | recorded |  |
| `POST /fs/paste-b64` | phone HIGH +token | 3 | recorded |  |
| `GET /symbols/lookup` |  | 4 | recorded |  |
| `GET /symbols/file` |  | 2 | recorded |  |
| `GET /symbols/search` |  | 2 | recorded |  |
| `POST /fs/create` | phone HIGH +token | 5 | recorded |  |
| `POST /fs/rename` | phone HIGH +token | 4 | recorded |  |
| `POST /fs/move` | phone HIGH +token | 3 | recorded |  |
| `POST /fs/trash` | phone HIGH +token | 3 | errors only | Opens a dialog, an app or a Finder action on the owner's screen. |
| `POST /fs/watch` | phone HIGH +token | 3 | recorded |  |
| `POST /fs/unwatch` | phone HIGH +token | 3 | recorded |  |
| `POST /fs/git/watch` | phone HIGH +token | 2 | recorded |  |
| `POST /fs/git/unwatch` | phone HIGH +token | 2 | recorded |  |
| `GET /fs/branches` | phone READ | 7 | recorded |  |
| `GET /fs/unpushed` | phone READ | 2 | recorded |  |
| `GET /fs/commit` | phone READ | 3 | recorded |  |
| `GET /fs/log` |  | 5 | recorded |  |
| `GET /fs/stashes` |  | 5 | recorded |  |
| `GET /fs/changes` |  | 9 | recorded |  |
| `GET /fs/changes/file` |  | 5 | recorded |  |
| `GET /fs/blob` |  | 3 | recorded |  |
| `POST /fs/checkout` | phone HIGH +token | 5 | recorded |  |
| `POST /fs/stash/apply` |  | 3 | recorded |  |
| `POST /fs/stash/drop` |  | 3 | recorded |  |
| `POST /fs/branch/create` | phone HIGH +token | 6 | recorded |  |
| `POST /fs/branch/rename` | phone HIGH +token | 3 | recorded |  |
| `POST /fs/branch/delete` | phone HIGH +token | 5 | recorded |  |
| `POST /fs/fetch` | phone HIGH +token | 2 | recorded |  |
| `POST /fs/remote-branch/delete` | phone HIGH +token | 2 | recorded |  |
| `GET /fs/recents` | phone READ | 4 | recorded |  |
| `POST /fs/recents/remove` |  | 3 | recorded |  |
| `GET /projects` |  | 4 | recorded |  |
| `PUT /projects` |  | 6 | recorded |  |
| `POST /projects/delete` |  | 3 | recorded |  |
| `GET /commands` | phone READ | 4 | recorded |  |
| `GET /api/templates` | phone READ | 4 | recorded |  |
| `POST /api/templates` | phone HIGH | 3 | recorded |  |
| `PUT /api/templates/:name` | phone HIGH | 3 | recorded |  |
| `DELETE /api/templates/:name` | phone HIGH | 3 | recorded |  |
| `GET /api/pages` | plugin | 9 | recorded |  |
| `GET /api/pages/:id` | plugin | 4 | recorded |  |
| `POST /api/pages` | plugin | 6 | recorded |  |
| `PUT /api/pages/:id` | plugin | 3 | recorded |  |
| `POST /api/pages/:id/edit` | plugin | 6 | recorded |  |
| `DELETE /api/pages/:id` | plugin | 6 | recorded |  |
| `POST /workers/:id/btw` | plugin | 4 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `GET /api/artifacts` | local-only, plugin | 4 | recorded |  |
| `POST /api/artifacts/refresh` | local-only, plugin | 2 | recorded |  |
| `GET /browser/status` | plugin | 5 | recorded |  |
| `POST /browser/launch` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `GET /browser/tabs` | plugin | 2 | recorded |  |
| `GET /browser/active-tab` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/show` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `DELETE /browser/tabs/:tabId` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/navigate` | plugin | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/snapshot` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/find` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/wait` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/act` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/get` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/capture` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/device` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/elements` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `POST /browser/tabs/:tabId/mute` | plugin | 1 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `PUT /workers/:id/rename-intent` | phone LOW, plugin | 3 | recorded |  |
| `GET /api/update` | local-only | 4 | recorded |  |
| `POST /api/update/check` | local-only | 3 | recorded |  |
| `POST /api/update/download` | local-only | 2 | recorded |  |
| `POST /api/update/restart` | local-only | 2 | errors only | Needs a staged update, which only a release build downloads. |
| `POST /api/update/later` | local-only | 2 | recorded |  |
| `POST /api/update/dismiss` | local-only | 2 | recorded |  |
| `PUT /api/settings/updates` | local-only | 2 | recorded |  |
| `GET /workers/:id/workflow-runs` | phone READ | 2 | recorded |  |
| `GET /workers/:id/workflow-runs/:callId` | phone READ | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/workflow-runs/:callId/agents/:agentId` | phone READ | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/workflow-runs/:callId/stop` | phone LOW +token | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /api/genui/views` |  | 6 | recorded |  |
| `POST /api/genui/apps` |  | 3 | recorded |  |
| `GET /api/genui/views/:id` |  | 4 | recorded |  |
| `GET /api/genui/views/:id/state` |  | 3 | recorded |  |
| `PUT /api/genui/views/:id/state` |  | 4 | recorded |  |
| `GET /api/genui/media/img` |  | 4 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/genui/media/og` |  | 1 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/genui/media/icon` |  | 2 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/genui/map/style.json` |  | 1 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/genui/map/t/:path` |  | 1 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/genui/geocode` |  | 2 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `POST /api/genui/places` |  | 2 | errors only | Goes to the network (model prices, maps, geocoding, images, provider checks). |
| `GET /api/location` | local-only | 3 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `GET /api/settings/genui` |  | 3 | recorded |  |
| `PUT /api/settings/genui` |  | 4 | recorded |  |
| `GET /api/dreams` |  | 5 | recorded |  |
| `GET /api/dreams/status` |  | 5 | recorded |  |
| `GET /api/dreams/:id` |  | 4 | recorded |  |
| `POST /api/dreams` |  | 3 | recorded |  |
| `POST /api/dreams/stop` |  | 2 | recorded |  |
| `POST /api/dreams/exclusions` |  | 3 | recorded |  |
| `GET /api/sync` | local-only | 3 | recorded |  |
| `GET /api/sync/key` | local-only | 3 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/sync/create` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/sync/join` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/sync/now` | local-only | 2 | recorded |  |
| `POST /api/sync/leave` | local-only | 2 | recorded |  |
| `GET /transfer/list` |  | 5 | recorded |  |
| `POST /transfer/scan` |  | 5 | recorded |  |
| `GET /transfer/read` |  | 3 | recorded |  |
| `PUT /transfer/write` |  | 3 | recorded |  |
| `POST /transfer/prepare` |  | 2 | recorded |  |
| `POST /transfer/commit` |  | 2 | recorded |  |
| `POST /transfer/abort` |  | 2 | recorded |  |
| `POST /transfer/key` |  | 2 | recorded |  |
| `POST /transfer/locate` |  | 2 | recorded |  |
| `GET /api/transfers` | local-only | 4 | recorded |  |
| `POST /api/transfers` | local-only | 3 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `DELETE /api/transfers` | local-only | 2 | recorded |  |
| `POST /api/transfers/destination` | local-only | 3 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/transfers/:id/:action` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /workers/:id/transfers` | local-only | 3 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `GET /workers/:id/transfers/:tid` | local-only | 3 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `GET /api/plugins` |  | 4 | recorded |  |
| `POST /api/plugins/install` | local-only | 5 | recorded |  |
| `POST /api/plugins/install/:stagingId` | local-only | 3 | recorded |  |
| `DELETE /api/plugins/install/:stagingId` | local-only | 3 | recorded |  |
| `POST /api/plugins/:id/update` | local-only | 3 | recorded |  |
| `DELETE /api/plugins/:id` | local-only | 3 | recorded |  |
| `GET /api/plugins/:id/status` |  | 3 | recorded |  |
| `POST /api/plugins/:id/report` |  | 2 | recorded |  |
| `GET /api/plugins/:id` |  | 6 | recorded |  |
| `PUT /api/plugins/:id/enabled` |  | 6 | recorded |  |
| `PUT /api/plugins/:id/settings` |  | 4 | recorded |  |
| `GET /api/plugins/:id/store/:key` |  | 4 | recorded |  |
| `PUT /api/plugins/:id/store/:key` |  | 2 | recorded |  |
| `POST /api/plugins/:id/preview` | local-only | 2 | errors only | Needs the Eos app window (the embedded browser, the plugin preview, location) or would start a browser on this Mac. |
| `GET /api/profile` |  | 3 | recorded |  |
| `PUT /api/profile` |  | 5 | recorded |  |
| `GET /api/profile/preview` |  | 5 | recorded |  |
| `GET /api/profile/avatar` |  | 3 | recorded |  |
| `PUT /api/profile/avatar` |  | 3 | recorded |  |
| `DELETE /api/profile/avatar` |  | 2 | recorded |  |
| `GET /api/profile/import/claude-md` |  | 3 | recorded |  |
| `GET /api/user-memories` |  | 5 | recorded |  |
| `POST /api/user-memories` |  | 5 | recorded |  |
| `POST /api/user-memories/suggest` |  | 7 | recorded |  |
| `GET /api/user-memories/search` |  | 4 | recorded |  |
| `POST /api/user-memories/approve-all` |  | 2 | recorded |  |
| `PUT /api/user-memories/:id` |  | 5 | recorded |  |
| `DELETE /api/user-memories/:id` |  | 3 | recorded |  |
| `POST /api/user-memories/:id/approve` |  | 2 | recorded |  |
| `POST /api/user-memories/:id/dismiss` |  | 2 | recorded |  |
| `GET /workers/:id/memory` | phone READ | 5 | recorded |  |
| `DELETE /workers/:id/memory/:name` | phone HIGH +token | 4 | recorded |  |
| `GET /api/prompts` | phone READ | 3 | recorded |  |
| `POST /api/prompts/preview` |  | 3 | recorded |  |
| `GET /worker-definitions` | phone READ | 10 | recorded |  |
| `POST /worker-definitions` |  | 4 | recorded |  |
| `GET /api/settings` | phone READ | 4 | recorded |  |
| `PUT /api/settings` | phone HIGH | 5 | recorded |  |
| `GET /api/settings/archive` |  | 3 | recorded |  |
| `PUT /api/settings/archive` |  | 3 | recorded |  |
| `GET /api/settings/compaction` |  | 3 | recorded |  |
| `PUT /api/settings/compaction` |  | 3 | recorded |  |
| `GET /api/anthropic/config` |  | 3 | recorded |  |
| `PUT /api/anthropic/config` |  | 3 | recorded |  |
| `GET /api/accounts` |  | 5 | recorded |  |
| `POST /api/accounts/:provider/sign-in` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `PUT /api/accounts/:provider/logins/:id` |  | 3 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `DELETE /api/accounts/:provider/logins/:id` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `PUT /api/accounts/:provider/default-login` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `PUT /api/accounts/:provider/auto-switch` |  | 3 | recorded |  |
| `DELETE /api/accounts/:provider/sign-in` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `PUT /workers/:id/plan-resume` |  | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/api-key-continue` |  | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /api/sign-ins/:id` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `DELETE /api/sign-ins/:id` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `POST /api/sign-ins/:id/code` |  | 2 | errors only | Starts or needs a real sign-in (a browser sign-in flow, a second Claude login, a key in the macOS Keychain). |
| `GET /api/usage` |  | 4 | recorded |  |
| `POST /workers` | phone HIGH | 1 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `DELETE /workers/:id` | phone HIGH | 3 | recorded |  |
| `POST /workers/:id/interrupt` | phone LOW | 3 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/archive` | phone LOW | 5 | recorded |  |
| `POST /workers/:id/restore` | phone LOW | 3 | recorded |  |
| `DELETE /workers/:id/purge` |  | 4 | recorded |  |
| `GET /workers` | phone READ | 7 | recorded |  |
| `GET /workers/archived` | phone READ | 4 | recorded |  |
| `POST /workers/archived/app-closed` |  | 2 | recorded |  |
| `GET /workers/:id` | phone READ | 12 | recorded |  |
| `GET /workers/:id/events` | phone READ | 20 | recorded |  |
| `POST /workers/:id/events` | local-only | 0 | not recorded | Not in the Rust app: the terminal-driven agent lane posted its rows here, and every agent now reports through its session. Today's daemon still serves it; nothing records it. |
| `POST /workers/:id/message` | phone LOW | 4 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `GET /workers/:id/queue` | phone READ | 2 | recorded |  |
| `DELETE /workers/:id/queue/:queueId` | phone LOW | 1 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/resume` | phone LOW | 2 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /workers/:id/action` | phone HIGH | 3 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /workers/:id/push` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/question` | local-only | 4 | recorded |  |
| `GET /workers/:id/question/:questionId` | local-only | 5 | recorded |  |
| `POST /workers/:id/question-answer` | phone LOW | 4 | recorded |  |
| `GET /workers/:id/peers` | phone READ | 3 | recorded |  |
| `POST /workers/:fromWorker/peer-request` | local-only | 2 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `GET /workers/:fromWorker/peer-request/:requestId` | local-only | 2 | recorded |  |
| `POST /workers/:id/peer-response` | local-only | 3 | recorded |  |
| `POST /workers/:id/notify` | phone LOW | 7 | recorded |  |
| `POST /workers/:id/keystroke` |  | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/rewind-targets` | phone READ | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/rewind` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/report` | local-only | 3 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `PUT /workers/:id/name` | phone LOW | 5 | recorded |  |
| `PUT /workers/:id/permission` | phone HIGH | 5 | recorded |  |
| `PUT /workers/:id/model` | phone LOW | 4 | recorded |  |
| `PUT /workers/:id/backend` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/diff` | phone READ | 2 | recorded |  |
| `GET /workers/:id/push-state` | phone READ | 2 | recorded |  |
| `GET /workers/:id/changes` | phone READ | 4 | recorded |  |
| `POST /workers/:id/warm` |  | 3 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /workers/:id/pull` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/try/preview` | phone READ | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/try/state` | phone READ | 2 | recorded |  |
| `POST /workers/:id/try` | phone HIGH | 3 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/try/keep` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/try/discard` | phone HIGH | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/terminal` | phone HIGH +token | 4 | recorded |  |
| `POST /terminal` | phone HIGH +token | 8 | recorded |  |
| `POST /terminal/:runId/kill` | phone HIGH | 3 | recorded |  |
| `POST /workers/:id/open` | phone HIGH +token | 3 | errors only | Opens a dialog, an app or a Finder action on the owner's screen. |
| `GET /workers/:id/conflicts` | phone READ | 2 | recorded |  |
| `GET /workers/:id/conflicts/file` | phone READ | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `POST /workers/:id/conflicts/resolve` | phone LOW | 2 | errors only | Needs a live agent session (a running turn, an open question, a worktree branch or a queued message), which only a real agent run produces. |
| `GET /workers/:id/changes/file` | phone READ | 3 | recorded |  |
| `POST /workers/:id/changes/discard` | phone HIGH +token | 3 | recorded |  |
| `GET /workers/:id/attachments` |  | 2 | recorded |  |
| `GET /workers/:id/prompt-events` |  | 3 | recorded |  |
| `GET /workers/:id/subagent-events` |  | 3 | recorded |  |
| `GET /api/jobs` |  | 5 | recorded |  |
| `GET /api/jobs/:id/output` |  | 3 | recorded |  |
| `POST /api/jobs/:id/stop` |  | 3 | recorded |  |
| `POST /api/jobs/:id/dismiss` |  | 2 | recorded |  |
| `POST /api/jobs/clear` |  | 2 | recorded |  |
| `POST /pty` | phone HIGH +token | 5 | recorded |  |
| `GET /pty` | phone READ +token | 5 | recorded |  |
| `POST /pty/:id/input` | phone HIGH +token | 4 | recorded |  |
| `POST /pty/:id/resize` |  | 2 | recorded |  |
| `GET /pty/:id/buffer` | phone READ +token | 3 | recorded |  |
| `GET /pty/:id/conversation` | phone READ +token | 6 | recorded |  |
| `POST /pty/:id/message` | phone HIGH +token | 5 | recorded |  |
| `POST /pty/:id/answer` | phone HIGH +token | 4 | recorded |  |
| `DELETE /pty/:id` | phone HIGH +token | 4 | recorded |  |
| `GET /workers/:id/export` |  | 3 | recorded |  |
| `GET /orchestrators` | phone READ | 4 | recorded |  |
| `POST /orchestrators` | phone HIGH | 1 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /orchestrators/:id/message` | phone LOW | 3 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /orchestrators/:id/integrate` | phone HIGH | 3 | errors only | Starts, messages or resumes an agent: a success would run a model. Only refusals are recorded. |
| `POST /orchestrators/:id/loop` | phone LOW | 0 | not recorded | Not in the Rust app: it has no goal loops (an orchestrator arming, amending or stopping one). Today's daemon still serves them; nothing records them. |
| `POST /orchestrators/:id/loop/stop` | phone LOW | 0 | not recorded | Not in the Rust app: it has no goal loops (an orchestrator arming, amending or stopping one). Today's daemon still serves them; nothing records them. |
| `POST /policy/decide` | local-only | 20 | recorded |  |
| `POST /api/policy/rule` | phone HIGH | 5 | recorded |  |
| `GET /pending` | phone READ | 7 | recorded |  |
| `POST /pending/:id/decision` | phone HIGH | 7 | recorded |  |
| `GET /api/remote/status` | local-only | 4 | recorded |  |
| `POST /api/remote/arm` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /api/remote/pair` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `PUT /api/remote/config` | local-only | 3 | recorded |  |
| `GET /h/:hostId/* (raw)` | local-only | 2 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `POST /h/:hostId/* (raw)` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `PUT /h/:hostId/* (raw)` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `DELETE /h/:hostId/* (raw)` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `HEAD /h/:hostId/* (raw)` | local-only | 1 | errors only | Needs another computer: a paired Mac, the phone relay or the sync vault. |
| `GET /fs/raw/* (raw)` | phone READ | 5 | recorded |  |
| `GET /pdfjs/* (raw)` | phone READ | 3 | recorded |  |

## `ROUTES` keys

| key | path | methods |
|---|---|---|
| `accountAutoSwitch` | `/api/accounts/:p0/auto-switch` | PUT recorded |
| `accountDefaultLogin` | `/api/accounts/:p0/default-login` | PUT errors only |
| `accountLogin` | `/api/accounts/:p0/logins/:p1` | PUT errors only, DELETE errors only |
| `accountSignIn` | `/api/accounts/:p0/sign-in` | POST errors only, DELETE errors only |
| `accounts` | `/api/accounts` | GET recorded |
| `anthropicConfig` | `/api/anthropic/config` | GET recorded, PUT recorded |
| `apiBackendDelete` | `/api/backends/:p0` | DELETE errors only |
| `apiBackendModels` | `/api/backends/:p0/models` | GET recorded |
| `apiBackendPresets` | `/api/backends/presets` | GET recorded, DELETE errors only |
| `apiBackendTest` | `/api/backends/test` | POST errors only, DELETE errors only |
| `apiBackends` | `/api/backends` | POST errors only |
| `artifacts` | `/api/artifacts` | GET recorded |
| `artifactsRefresh` | `/api/artifacts/refresh` | POST recorded |
| `browserAct` | `/browser/tabs/:p0/act` | POST errors only |
| `browserActiveTab` | `/browser/active-tab` | GET errors only |
| `browserCapture` | `/browser/tabs/:p0/capture` | POST errors only |
| `browserDevice` | `/browser/tabs/:p0/device` | POST errors only |
| `browserElements` | `/browser/tabs/:p0/elements` | POST errors only |
| `browserFind` | `/browser/tabs/:p0/find` | POST errors only |
| `browserGet` | `/browser/tabs/:p0/get` | POST errors only |
| `browserLaunch` | `/browser/launch` | POST errors only |
| `browserMute` | `/browser/tabs/:p0/mute` | POST errors only |
| `browserNavigate` | `/browser/tabs/:p0/navigate` | POST errors only |
| `browserShow` | `/browser/show` | POST errors only |
| `browserSnapshot` | `/browser/tabs/:p0/snapshot` | POST errors only |
| `browserStatus` | `/browser/status` | GET recorded |
| `browserTab` | `/browser/tabs/:p0` | DELETE errors only |
| `browserTabs` | `/browser/tabs` | GET recorded, POST errors only |
| `browserWait` | `/browser/tabs/:p0/wait` | POST errors only |
| `commands` | `/commands` | GET recorded |
| `datetime` | `/datetime` | GET recorded |
| `dream` | `/api/dreams/:p0` | GET recorded |
| `dreamExclusions` | `/api/dreams/exclusions` | POST recorded |
| `dreamStatus` | `/api/dreams/status` | GET recorded |
| `dreamStop` | `/api/dreams/stop` | POST recorded |
| `dreams` | `/api/dreams` | GET recorded, POST recorded |
| `fsBlob` | `/fs/blob` | GET recorded |
| `fsBranchCreate` | `/fs/branch/create` | POST recorded |
| `fsBranchDelete` | `/fs/branch/delete` | POST recorded |
| `fsBranchRename` | `/fs/branch/rename` | POST recorded |
| `fsBranches` | `/fs/branches` | GET recorded |
| `fsChanges` | `/fs/changes` | GET recorded |
| `fsChangesFile` | `/fs/changes/file` | GET recorded |
| `fsCheckout` | `/fs/checkout` | POST recorded |
| `fsCommit` | `/fs/commit` | GET recorded |
| `fsCreate` | `/fs/create` | POST recorded |
| `fsDefaultApp` | `/fs/default-app` | GET recorded |
| `fsEditors` | `/fs/editors` | GET recorded |
| `fsFetch` | `/fs/fetch` | POST recorded |
| `fsGitUnwatch` | `/fs/git/unwatch` | POST recorded |
| `fsGitWatch` | `/fs/git/watch` | POST recorded |
| `fsIcon` | `/fs/icon` | GET recorded |
| `fsImage` | `/fs/image` | GET recorded |
| `fsList` | `/fs/list` | GET recorded |
| `fsLog` | `/fs/log` | GET recorded |
| `fsMove` | `/fs/move` | POST recorded |
| `fsOpen` | `/fs/open` | POST errors only |
| `fsOpenIn` | `/fs/open-in` | POST errors only |
| `fsPaste` | `/fs/paste` | POST recorded |
| `fsPasteB64` | `/fs/paste-b64` | POST recorded |
| `fsRaw` | `/fs/raw` | GET recorded |
| `fsRead` | `/fs/read` | GET recorded |
| `fsRecents` | `/fs/recents` | GET recorded |
| `fsRecentsRemove` | `/fs/recents/remove` | POST recorded |
| `fsRemoteBranchDelete` | `/fs/remote-branch/delete` | POST recorded |
| `fsRename` | `/fs/rename` | POST recorded |
| `fsReveal` | `/fs/reveal` | POST errors only |
| `fsStashApply` | `/fs/stash/apply` | POST recorded |
| `fsStashDrop` | `/fs/stash/drop` | POST recorded |
| `fsStashes` | `/fs/stashes` | GET recorded |
| `fsStat` | `/fs/stat` | GET recorded |
| `fsTrash` | `/fs/trash` | POST errors only |
| `fsUnpushed` | `/fs/unpushed` | GET recorded |
| `fsUnwatch` | `/fs/unwatch` | POST recorded |
| `fsWatch` | `/fs/watch` | POST recorded |
| `fsWrite` | `/fs/write` | POST recorded |
| `genuiApps` | `/api/genui/apps` | POST recorded |
| `genuiGeocode` | `/api/genui/geocode` | GET errors only |
| `genuiMap` | `/api/genui/map` | GET errors only, GET errors only |
| `genuiMediaIcon` | `/api/genui/media/icon` | GET errors only |
| `genuiMediaImg` | `/api/genui/media/img` | GET errors only |
| `genuiMediaOg` | `/api/genui/media/og` | GET errors only |
| `genuiPlaces` | `/api/genui/places` | POST errors only |
| `genuiView` | `/api/genui/views/:p0` | GET recorded |
| `genuiViewState` | `/api/genui/views/:p0/state` | GET recorded, PUT recorded |
| `genuiViews` | `/api/genui/views` | POST recorded |
| `health` | `/health` | GET recorded |
| `host` | `/api/hosts/:p0` | PUT errors only, DELETE errors only |
| `hostInfo` | `/api/host` | GET recorded |
| `hostProxyPrefix` | `/h/:p0` | GET errors only, POST errors only, PUT errors only, DELETE errors only, HEAD errors only, GET errors only, POST errors only, PUT errors only, DELETE errors only, HEAD errors only |
| `hostReconnect` | `/api/hosts/:p0/reconnect` | POST errors only |
| `hostViewToken` | `/api/hosts/:p0/view-token` | POST errors only |
| `hosts` | `/api/hosts` | GET recorded, POST errors only |
| `jobDismiss` | `/api/jobs/:p0/dismiss` | POST recorded |
| `jobOutput` | `/api/jobs/:p0/output` | GET recorded |
| `jobStop` | `/api/jobs/:p0/stop` | POST recorded |
| `jobs` | `/api/jobs` | GET recorded |
| `jobsClear` | `/api/jobs/clear` | POST recorded |
| `location` | `/api/location` | GET errors only |
| `metrics` | `/metrics` | GET recorded |
| `modelCatalogRefresh` | `/api/model-catalog/refresh` | POST not recorded |
| `orchestratorIntegrate` | `/orchestrators/:p0/integrate` | POST errors only |
| `orchestratorLoop` | `/orchestrators/:p0/loop` | POST not recorded |
| `orchestratorLoopStop` | `/orchestrators/:p0/loop/stop` | POST not recorded |
| `orchestratorMessage` | `/orchestrators/:p0/message` | POST errors only |
| `orchestrators` | `/orchestrators` | GET recorded, POST errors only |
| `page` | `/api/pages/:p0` | GET recorded, PUT recorded, DELETE recorded |
| `pageEdit` | `/api/pages/:p0/edit` | POST recorded |
| `pages` | `/api/pages` | GET recorded, POST recorded |
| `pdfjs` | `/pdfjs` | GET recorded |
| `peer` | `/api/peer` | GET recorded, PUT recorded |
| `peerDevice` | `/api/peer/devices/:p0` | DELETE errors only |
| `peerDeviceDisconnect` | `/api/peer/devices/:p0/disconnect` | POST recorded |
| `peerInvite` | `/api/peer/invite` | POST errors only, DELETE recorded |
| `peerPair` | `/peer/pair` | no route registered |
| `peerReverse` | `/peer/reverse` | no route registered |
| `pending` | `/pending` | GET recorded |
| `pendingDecision` | `/pending/:p0/decision` | POST recorded |
| `pickDirectory` | `/pick-directory` | GET not recorded |
| `pickFile` | `/pick-file` | GET not recorded |
| `plugin` | `/api/plugins/:p0` | DELETE recorded, GET recorded |
| `pluginEnabled` | `/api/plugins/:p0/enabled` | POST recorded, DELETE recorded, PUT recorded |
| `pluginInstall` | `/api/plugins/install` | POST recorded, DELETE recorded, GET recorded |
| `pluginPreview` | `/api/plugins/:p0/preview` | POST recorded, DELETE recorded, POST errors only |
| `pluginReport` | `/api/plugins/:p0/report` | POST recorded, DELETE recorded, POST recorded |
| `pluginSettings` | `/api/plugins/:p0/settings` | POST recorded, DELETE recorded, PUT recorded |
| `pluginStaged` | `/api/plugins/install/:p0` | POST recorded, DELETE recorded, POST recorded, GET recorded, POST recorded, PUT recorded, PUT recorded, POST errors only |
| `pluginStatus` | `/api/plugins/:p0/status` | POST recorded, DELETE recorded, GET recorded |
| `pluginStore` | `/api/plugins/:p0/store/:p1` | GET recorded, PUT recorded |
| `pluginUpdate` | `/api/plugins/:p0/update` | POST recorded, DELETE recorded, POST recorded |
| `plugins` | `/api/plugins` | GET recorded |
| `policyDecide` | `/policy/decide` | POST recorded |
| `policyRule` | `/api/policy/rule` | POST recorded |
| `profile` | `/api/profile` | GET recorded, PUT recorded |
| `profileAvatar` | `/api/profile/avatar` | GET recorded, PUT recorded, DELETE recorded |
| `profileImportClaudeMd` | `/api/profile/import/claude-md` | GET recorded |
| `profilePreview` | `/api/profile/preview` | GET recorded |
| `projects` | `/projects` | GET recorded, PUT recorded |
| `projectsDelete` | `/projects/delete` | POST recorded |
| `promptPreview` | `/api/prompts/preview` | POST recorded |
| `prompts` | `/api/prompts` | GET recorded |
| `pty` | `/pty` | POST recorded, GET recorded |
| `ptyAnswer` | `/pty/:p0/answer` | POST recorded |
| `ptyBuffer` | `/pty/:p0/buffer` | GET recorded |
| `ptyConversation` | `/pty/:p0/conversation` | GET recorded |
| `ptyInput` | `/pty/:p0/input` | POST recorded |
| `ptyMessage` | `/pty/:p0/message` | POST recorded |
| `ptyResize` | `/pty/:p0/resize` | POST recorded |
| `ptySession` | `/pty/:p0` | DELETE recorded |
| `remoteArm` | `/api/remote/arm` | POST errors only |
| `remoteConfig` | `/api/remote/config` | PUT recorded |
| `remotePair` | `/api/remote/pair` | POST errors only |
| `remoteStatus` | `/api/remote/status` | GET recorded |
| `settings` | `/api/settings` | GET recorded, PUT recorded |
| `settingsArchive` | `/api/settings/archive` | GET recorded, PUT recorded |
| `settingsCompaction` | `/api/settings/compaction` | GET recorded, PUT recorded |
| `settingsGenui` | `/api/settings/genui` | GET recorded, PUT recorded |
| `settingsUpdates` | `/api/settings/updates` | PUT recorded |
| `signIn` | `/api/sign-ins/:p0` | GET errors only, DELETE errors only |
| `signInCode` | `/api/sign-ins/:p0/code` | POST errors only |
| `stream` | `/stream` | GET recorded |
| `streamFocus` | `/stream/focus` | POST recorded |
| `symbolsFile` | `/symbols/file` | GET recorded |
| `symbolsLookup` | `/symbols/lookup` | GET recorded |
| `symbolsSearch` | `/symbols/search` | GET recorded |
| `sync` | `/api/sync` | GET recorded |
| `syncCreate` | `/api/sync/create` | POST errors only |
| `syncJoin` | `/api/sync/join` | POST errors only |
| `syncKey` | `/api/sync/key` | GET errors only |
| `syncLeave` | `/api/sync/leave` | POST recorded |
| `syncNow` | `/api/sync/now` | POST recorded |
| `template` | `/api/templates/:p0` | PUT recorded, DELETE recorded |
| `templates` | `/api/templates` | GET recorded, POST recorded |
| `terminal` | `/terminal` | POST recorded |
| `terminalKill` | `/terminal/:p0/kill` | POST recorded |
| `transferAbort` | `/transfer/abort` | POST recorded |
| `transferCancel` | `/api/transfers/:p0/cancel` | POST errors only |
| `transferCommit` | `/transfer/commit` | POST recorded |
| `transferDecide` | `/api/transfers/:p0/decide` | POST errors only |
| `transferDestination` | `/api/transfers/destination` | POST errors only |
| `transferKey` | `/transfer/key` | POST recorded |
| `transferList` | `/transfer/list` | GET recorded |
| `transferLocate` | `/transfer/locate` | POST recorded |
| `transferPause` | `/api/transfers/:p0/pause` | POST errors only |
| `transferPrepare` | `/transfer/prepare` | POST recorded |
| `transferRead` | `/transfer/read` | GET recorded |
| `transferResume` | `/api/transfers/:p0/resume` | POST errors only |
| `transferScan` | `/transfer/scan` | POST recorded |
| `transferWrite` | `/transfer/write` | PUT recorded |
| `transfers` | `/api/transfers` | GET recorded, POST errors only, DELETE recorded |
| `uiConfig` | `/api/ui-config` | GET recorded |
| `update` | `/api/update` | GET recorded |
| `updateCheck` | `/api/update/check` | POST recorded |
| `updateDismiss` | `/api/update/dismiss` | POST recorded |
| `updateDownload` | `/api/update/download` | POST recorded |
| `updateLater` | `/api/update/later` | POST recorded |
| `updateRestart` | `/api/update/restart` | POST errors only |
| `usage` | `/api/usage` | GET recorded |
| `userMemories` | `/api/user-memories` | GET recorded, POST recorded |
| `userMemoriesApproveAll` | `/api/user-memories/approve-all` | POST recorded |
| `userMemory` | `/api/user-memories/:p0` | PUT recorded, DELETE recorded |
| `userMemoryApprove` | `/api/user-memories/:p0/approve` | POST recorded |
| `userMemoryDismiss` | `/api/user-memories/:p0/dismiss` | POST recorded |
| `userMemorySearch` | `/api/user-memories/search` | GET recorded |
| `userMemorySuggest` | `/api/user-memories/suggest` | POST recorded |
| `worker` | `/workers/:p0` | DELETE recorded, GET recorded |
| `workerAction` | `/workers/:p0/action` | POST errors only |
| `workerApiKeyContinue` | `/workers/:p0/api-key-continue` | POST errors only |
| `workerArchive` | `/workers/:p0/archive` | POST recorded |
| `workerAttachments` | `/workers/:p0/attachments` | GET recorded |
| `workerBackend` | `/workers/:p0/backend` | PUT errors only |
| `workerChanges` | `/workers/:p0/changes` | GET recorded |
| `workerChangesDiscard` | `/workers/:p0/changes/discard` | POST recorded |
| `workerConflictFile` | `/workers/:p0/conflicts/file` | GET errors only |
| `workerConflictResolve` | `/workers/:p0/conflicts/resolve` | POST errors only |
| `workerConflicts` | `/workers/:p0/conflicts` | GET recorded |
| `workerDefinitions` | `/worker-definitions` | GET recorded, POST recorded |
| `workerDiff` | `/workers/:p0/diff` | GET recorded |
| `workerEvents` | `/workers/:p0/events` | GET recorded, POST not recorded |
| `workerExport` | `/workers/:p0/export` | GET recorded |
| `workerFileDiff` | `/workers/:p0/changes/file` | GET recorded |
| `workerInterrupt` | `/workers/:p0/interrupt` | POST errors only |
| `workerKeystroke` | `/workers/:p0/keystroke` | POST errors only |
| `workerMemory` | `/workers/:p0/memory` | GET recorded |
| `workerMemoryItem` | `/workers/:p0/memory/:p1` | DELETE recorded |
| `workerMessage` | `/workers/:p0/message` | POST errors only |
| `workerModel` | `/workers/:p0/model` | PUT recorded |
| `workerName` | `/workers/:p0/name` | PUT recorded |
| `workerNotify` | `/workers/:p0/notify` | POST recorded |
| `workerOpen` | `/workers/:p0/open` | POST errors only |
| `workerPeerRequest` | `/workers/:p0/peer-request` | POST errors only |
| `workerPeerRequestPoll` | `/workers/:p0/peer-request/:p1` | GET recorded |
| `workerPeerResponse` | `/workers/:p0/peer-response` | POST recorded |
| `workerPeers` | `/workers/:p0/peers` | GET recorded |
| `workerPermission` | `/workers/:p0/permission` | PUT recorded |
| `workerPlanResume` | `/workers/:p0/plan-resume` | PUT errors only |
| `workerPromptEvents` | `/workers/:p0/prompt-events` | GET recorded |
| `workerPull` | `/workers/:p0/pull` | POST errors only |
| `workerPurge` | `/workers/:p0/purge` | DELETE recorded |
| `workerPush` | `/workers/:p0/push` | POST errors only |
| `workerPushState` | `/workers/:p0/push-state` | GET recorded |
| `workerQuestion` | `/workers/:p0/question` | POST recorded |
| `workerQuestionAnswer` | `/workers/:p0/question-answer` | POST recorded |
| `workerQuestionPoll` | `/workers/:p0/question/:p1` | GET recorded |
| `workerQueue` | `/workers/:p0/queue` | GET recorded |
| `workerQueueItem` | `/workers/:p0/queue/:p1` | DELETE errors only |
| `workerRenameIntent` | `/workers/:p0/rename-intent` | PUT recorded |
| `workerReport` | `/workers/:p0/report` | POST errors only |
| `workerRestore` | `/workers/:p0/restore` | POST recorded |
| `workerResume` | `/workers/:p0/resume` | POST errors only |
| `workerRewind` | `/workers/:p0/rewind` | POST errors only |
| `workerRewindTargets` | `/workers/:p0/rewind-targets` | GET errors only |
| `workerSideQuestion` | `/workers/:p0/btw` | POST errors only |
| `workerSubagentEvents` | `/workers/:p0/subagent-events` | GET recorded |
| `workerTerminal` | `/workers/:p0/terminal` | POST recorded |
| `workerTransfer` | `/workers/:p0/transfers/:p1` | GET errors only |
| `workerTransfers` | `/workers/:p0/transfers` | POST errors only |
| `workerTry` | `/workers/:p0/try` | POST errors only |
| `workerTryDiscard` | `/workers/:p0/try/discard` | POST errors only |
| `workerTryKeep` | `/workers/:p0/try/keep` | POST errors only |
| `workerTryPreview` | `/workers/:p0/try/preview` | GET errors only |
| `workerTryState` | `/workers/:p0/try/state` | GET recorded |
| `workerWarm` | `/workers/:p0/warm` | POST errors only |
| `workerWorkflowAgent` | `/workers/:p0/workflow-runs/:p1/agents/:p2` | GET errors only |
| `workerWorkflowRun` | `/workers/:p0/workflow-runs/:p1` | GET errors only |
| `workerWorkflowRunStop` | `/workers/:p0/workflow-runs/:p1/stop` | POST errors only |
| `workerWorkflowRuns` | `/workers/:p0/workflow-runs` | GET recorded |
| `workers` | `/workers` | POST errors only, GET recorded |
| `workersArchived` | `/workers/archived` | DELETE recorded, GET recorded, GET recorded |
| `workersArchivedAppClosed` | `/workers/archived/app-closed` | POST recorded |
