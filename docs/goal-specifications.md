# Drafting a goal

Choose **New goal** from a project or Goals. Write the desired outcome, build a Markdown specification, and add observable completion criteria. **Import .md** reads an existing specification. Execution settings remain available beneath the editor.

Drafts are saved locally per project on the device running the app or browser. They survive closing the dialog, switching projects and restarting the app. This local draft is not replicated between devices. If storage is unavailable, the editor reports it. Creating a goal successfully clears that project's local draft; failed creation preserves it.

The **Goal assistant** uses an existing project environment or starts a new isolated drafting environment. Prepare the selected agent and connect its account through the ordinary runtime controls. Starting the conversation sends the current draft and asks the agent to discuss requirements and inspect the project before execution. Questions and approvals use the existing conversation controls. **Send current draft** shares subsequent editor changes with that conversation.

Structured proposals appear as readable goal cards with the specification and raw response available for inspection. **Use draft** copies the proposed name, outcome, specification and completion criteria into the editor. It does not change execution policy, start a factory goal or overwrite the draft automatically. Malformed responses cannot replace the draft.

**Create goal** submits the edited contract. The full specification is included under a `Specification` heading in the existing durable objective, so the planner, workers and evaluator receive it on current device services. Chats stay on their owning device and remain available from the environment after the drafting dialog closes. Closing the dialog leaves its environment and any running conversation active.

Verification covers structured proposal validation and full specification preservation, a component workflow with deterministic agent output, and the shared renderer's production build. The UI fixture is not evidence of a new model execution; agent runners and device APIs are reused without changes.
