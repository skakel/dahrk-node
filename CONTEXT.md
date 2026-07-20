# dahrk-node - domain model

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

`dahrk-node` is the installable edge client (Apache-2.0). Run and enrolled with a hub, it becomes an
**edge node** and executes workflow stages in a git worktree. The shared kernel below is the cross-repo
vocabulary (mirrored from the harness workspace); the terms in it - hub, edge node, run, stage, job,
worktree, runner adapter, trace - are the product language this client implements.

<!-- BEGIN shared-kernel (canonical: workspace-root /CONTEXT.md - do not edit in repo copies; run scripts/sync-context.sh) -->
## Shared language (the kernel)

### Product and organisation

**Dahrk**:
The product - a Linear-native agent-workflow harness - and the Linear agent handle (`@Dahrk`) that
users assign or @mention.
_Avoid_: the bot, the agent (when you mean the product).

**Skakel Labs**:
The company that owns Dahrk.
_Avoid_: Dahrk Inc.

### The two deployables

**Hub**:
The single deployed, owned service. Ingests Linear webhooks, authenticates them, hosts the engine,
holds the workflow registry, runs the WebSocket server, and routes Jobs to nodes. The only public
inbound endpoint.
_Avoid_: Server, backend, orchestrator.

**Edge node**:
A deliberate worker (a Mac or a VPS) that connects **outbound** to the hub over WebSocket and runs
stages. It has **no inbound ports**. "Node" always means an edge node.
_Avoid_: Worker, agent, runner (a runner is the thing inside a stage, not the node).

### The one rule

**Determinism boundary**:
The invariant that the engine is pure deterministic TypeScript and **no LLM call ever decides control
flow**. Inference happens only inside a stage. Wanting an LLM to choose the next step is a design
error, not a feature.
_Avoid_: Orchestration logic, agentic routing.

**Engine**:
The pure-deterministic workflow runner hosted inside the hub. Sequences stages, evaluates
gates / branches / `on_fail` loops, and dispatches Jobs. Contains no LLM calls.
_Avoid_: Orchestrator, scheduler, controller.

### The work hierarchy

**Workflow**:
The versioned definition of a stage graph for an issue: the ordered stages, their gates, branches,
and loops. Hub-owned and DB-canonical.
_Avoid_: Pipeline, playbook, recipe.

**Run**:
One execution of a workflow for one Linear issue. Scope: the whole issue.
_Avoid_: Job (a job is one stage dispatch), session, execution.

**Stage**:
One node in the workflow graph: a runtime + model + prompt/skill + tools + interaction mode. Part of
a run.
_Avoid_: Step, task, phase.

**Job**:
One dispatch of one stage to one executor - the unit the engine hands to a node, correlated by
`jobId`. The load-bearing seam between engine and executor.
_Avoid_: Turn (deprecated), task, message.

**Attempt**:
One (re-)dispatch of a stage. A re-run writes `attempt-<n>/`; earlier attempts are never clobbered.
_Avoid_: Retry, try.

### The execution surface

**Worktree**:
The git worktree created once at run start and shared by every stage, torn down at run end. The
carrier of context between stages (never a live LLM conversation - stages swap runtimes).
_Avoid_: Checkout, clone, sandbox.

**Runner adapter**:
A thin wrapper over a vendor agent SDK (Claude Agent SDK, Codex SDK, Pi) implementing the internal
`Runner` interface. One per runtime. Produces the normalised trace.
_Avoid_: Driver, plugin, agent.

**Trace**:
The per-stage raw execution record: a normalised JSONL event stream of the agent's actions.
_Avoid_: Log, transcript, history.

**Summary**:
The engine-owned, one-paragraph index into a stage's trace, surfaced to Linear and handed to the next
stage. Not the sole carrier of context.
_Avoid_: Report, digest.

### Identity and authentication

**Tenant**:
The top isolation boundary for the future SaaS. In Phase 1 it is pinned to one constant and never
varied. Tenant 0 is the platform itself, not a customer.
_Avoid_: Org, customer, account (as synonyms).

**Connection**:
One Linear OAuth app install acting as an agent (`actor=app`). The unit of authentication. One
Connection can expose several Workspaces.
_Avoid_: Integration, install, org.

**Workspace**:
A Linear workspace exposed by a Connection. Contains the issues that become runs.
_Avoid_: Org, team (a team is a subdivision of a workspace).

### The control surface

**Control surface**:
Linear's Agent Session API, used natively: activities for progress, the agent-plan checklist for the
stage graph, elicitations for gates, the `prompted` webhook for drive, the `stop` signal for cancel.
_Avoid_: UI, dashboard, API (when you mean this specifically).

**Gate**:
A deterministic pause for a human, raised as a Linear `elicitation`. Used between stages and by an
`ask` policy verdict.
_Avoid_: Approval, checkpoint, pause.

**Policy**:
A deterministic guard returning `allow` / `deny` / `ask` around a tool call or at stage entry. Never
an LLM call; never chooses the next stage.
_Avoid_: Rule, guardrail, filter.

### The shared code seam

**`@dahrk/contracts`**:
The published npm package carrying the wire protocol (Job request/result, WebSocket frames, the trace
envelope, data classification). The literal shared kernel in code; hand-published from the harness.
_Avoid_: The SDK, the types package, the API.
<!-- END shared-kernel -->

## Node-local language

**Enrolment**:
The one-time exchange that turns an installed `dahrk-node` into a trusted edge node: it advertises to
the hub and presents a short-lived hub-minted enrolment token over the WebSocket.
_Avoid_: Registration, pairing, login.

**Ambient node**:
A node that authenticates to git, inference, and MCP servers with the operator's own locally installed
credentials (SSH agent, `gh` auth, `claude` keychain). The hub sends no credential material. The
free-tier default for self-hosted nodes.
_Avoid_: Unmanaged (imprecise; describes a mode, not the credential model).

**Brokered node**:
A node that receives short-lived, per-job credentials minted by the hub's credential broker instead of
holding long-lived secrets. Used by managed and self-hosted container nodes.
_Avoid_: Managed (managed is a hosting model; brokered is a credential model - orthogonal).

**Mirror cache**:
The edge-local bare-repo cache (`~/.dahrk/mirrors/<repoId>`) the node fetches into before creating a
worktree, so repeated runs against a repo do not re-clone.
_Avoid_: Cache, local clone.

**RuntimeSession**:
The loop-facing, turn-level port inside `executor-worktree` (`sendTurn` / `summariseTurn` / `cost` /
`dispose`) that the one shared interactive/batch loop (`runInteractiveLoop` / `runBatchLoop` in
`runner-shared.ts`) drives. Each runtime implements it and keeps its native-event mapping and
stage-complete detection inside the session, so the loop never sees a `PiEvent` or `SDKMessage`. Both
Pi back-ends (embedded and container) drive it. Distinct from the lower `PiSessionLike` transport seam
(`subscribe` / `prompt` / `abort`), which stays the SDK/RPC-facing boundary beneath it.
_Avoid_: Session (unqualified), runner (a runner is the `Runner`-shaped adapter wrapping this).

## Sources

- Workspace-root `CONTEXT.md` - the shared kernel this file mirrors.
- `dahrk-harness/docs/data-boundary.md` - the ambient vs brokered credential model.
- `docs/logging.md` - the node's edge-local logs, crash records, and `dahrk diagnose`.
