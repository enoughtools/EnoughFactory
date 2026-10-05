@AGENTS.md

# Claude Code only

Everything above is imported from `AGENTS.md`, which is the one copy every runtime reads. Add guidance
there. This file holds only what is true of Claude Code and nothing else.

- The repository has no `.claude/` directory: no project settings, hooks or slash commands to expect.
- `.claude-plugin/plugin.json` and `skills/envmux-delegate/SKILL.md` are the **envmux plugin that users
  install** — a product artefact, reviewed like code. It is not a skill for working on this repository.
- That skill defers to the binary: the authoritative briefing is `envmux agent prompt`, whose text is
  `AgentPrompt` in `src/Envmux/Agents/AgentPrompt.cs` and is pinned by `AgentCommandTests`. When the
  `envmux agent` grammar changes, change it there; `SKILL.md` says how to work, not what to type.
- `envmux autoconfigure` prints a prompt meant to be run as `claude "$(envmux autoconfigure)"`.
  `Commands/AutoconfigureCommand.cs` is therefore prompt text with tests (`AutoconfigureTests`), and an
  edit to it is read by a model, not a person.
- `"tools": { "claude": "auto" }` in an `.envmux.json` copies this machine's Claude credentials into an
  instance. Never add it to a config yourself; say what it does and let the user decide.
