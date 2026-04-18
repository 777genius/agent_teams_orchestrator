# Company Portability And Package Model

## Why this is interesting

This is one of Paperclip's more original ideas.

It does not only orchestrate companies at runtime.
It also tries to make companies portable as markdown-first packages.

## What exists

Paperclip has:

- a company portability service
- import/export routes and CLI flows
- GitHub-native import support
- a vendor-neutral `agentcompanies/v1-draft` spec
- sidecar `.paperclip.yaml` for Paperclip-specific fidelity

That is strategically interesting.

## What is strong

### Markdown-first portability

This is a very good idea:

- human-readable
- Git-friendly
- works from local folder or GitHub repo
- portable identity by slug/path, not DB id

### Vendor-neutral base spec

The `companies-spec` does something smart:

- keeps package structure portable
- keeps vendor-specific fidelity in optional extensions

That is good architectural taste.

### Import preview and collision strategies

The system supports:

- dry-run preview
- rename/skip/replace collision policies
- selective include scopes

That is much better than naive "import everything blindly".

## Strategic upside

This creates a powerful product direction:

- reusable companies
- reusable teams
- template marketplaces
- Git-native sharing of org patterns

This is a place where Paperclip thinks beyond basic orchestration.

## Risks

### 1. Portability can outrun operational closure

Issue `#3918` is a good warning:

- import can hit approval-policy/runtime gaps
- there may be no clean primitive to finish the intended flow afterward

Important nuance from the deeper pass:

- current `master` import code now appears to create new imported agents with `pending_approval` when `requireBoardApprovalForNewAgents` is enabled
- that suggests the live head is closer to the honest behavior than the issue report on `v2026.416.0`

So the strategic lesson is not "portability is weak".

It is:

⚠️ portability features are only trustworthy if governance-gated import paths either create explicit pending objects or fail loudly.

### 2. Package fidelity vs runtime truth is expensive

Once companies become packages, Paperclip has to decide what is:

- portable package truth
- local runtime truth
- secret/operator-local truth

That is a real architecture tax.

### 3. Product promises get broader fast

Once import/export exists, users start expecting:

- turnkey templates
- full-fidelity cloning
- marketplace-quality reuse

That is strategically powerful and operationally expensive.

## Architect takeaway

Steal:

- markdown-first portability
- GitHub-native import/export
- vendor-neutral package core with optional runtime sidecar

Avoid:

- promising portable full-fidelity companies before the runtime/operator loop is closed enough to honor them safely
