# Pi agents panel

Agent Depot declares `resources/pi/agents-panel/index.ts` as its only Pi Package component. Package discovery reads the root manifest and exposes the repository as a Pi Package. The manifest declares no Skills. Pi owns Package installation and installed state. Agent Depot does not create a Skill or App record for this extension.

The panel command is `/agents`. It displays snapshots from a Pi extension that publishes the provider contract below. The command name is shared with pstack's existing panel, so the Agent Depot Package and pstack adapter must be installed as one coordinated migration. The adapter patch removes pstack's old command registration and replaces it with the snapshot provider. Do not install the Agent Depot panel alongside an unpatched pstack extension. Pi does not expose a command-unregister API, so loading both registrations can cause a collision.

## Provider contract

The panel and provider communicate through Pi's shared `pi.events` bus. The contract is versioned in `resources/pi/agents-panel/contract.ts`.

The panel emits `agent-depot:agents:v1:request` with `{ version: 1, requestId }`. The provider answers on `agent-depot:agents:v1:snapshot` with `{ version: 1, requestId, agents }`. The panel rejects malformed responses, unsupported versions, and responses to older requests. It asks for a snapshot once per second and treats a request with no reply after two seconds as unavailable. On timeout, it clears the previous snapshot instead of presenting stale agents as current.

Each agent snapshot includes its stable ID, description, agent type, resolved model, thinking level, read-only flag, status, process kind, start and end dates, elapsed duration, telemetry-observed flag, latest activity, measured token and cost fields, and optional worktree. Missing telemetry stays missing. The panel does not estimate usage or read session files to synthesize agents.

The event bus carries `unknown`, so the panel validates each response with the TypeBox schema before rendering it. Provider data is read-only. The panel sorts active agents first and then orders each status group by start date, newest first. Selection follows the stable ID across refreshes and status changes.

## Coordinated pstack adapter

The installed pstack extension currently passes its private `AgentRunner` directly to its `/agents` panel. It does not publish the provider contract. The separate patch in `docs/pi-agents-panel-pstack-adapter.patch` changes pstack's extension to answer snapshot requests with `AgentRunner.snapshot()` and removes its old command registration. Apply and review that patch in the pstack project, then install the Agent Depot Package as part of the same migration. This repository does not change the installed pstack checkout.

The adapter uses pstack's runner as the source of status, activity, stable IDs, and measured usage. It does not create agent records or fill in missing telemetry. Do not claim end-to-end integration until a real pstack run returns a completed snapshot through the event contract with measured usage.

## Design choices

A direct import of pstack's `AgentRunner` would make Agent Depot depend on an internal module that is not a public Pi API. The event contract keeps that dependency out of the panel.

Reading persisted session entries would miss live child telemetry and could present restored records as current observations. The provider must report what its runner measured, including when it did not capture telemetry.

## Verification

Run `pnpm test:single tests/pi-agents-panel.test.ts` for panel behavior and `pnpm test:single tests/package-bundles.test.ts` for Package discovery. Run `pnpm test:pack` to inspect the npm tarball, install it with ordinary npm, and verify that npm does not fetch the optional Pi host peers. Test Pi package loading with temporary `PI_CODING_AGENT_DIR` and `HOME` paths. Do not install into the real user directory.
