# Domain And Control Plane

## Strongest architectural move

Paperclip treats business objects as real persisted entities.

The center of the product is not "the model session".

It is:

- company
- agent
- org edge
- goal
- project
- issue
- approval
- budget policy
- budget incident
- membership
- heartbeat run

That is a big reason the system feels more substantial than many competitors.

## The domain model is opinionated in good ways

### Company-scoped everything

The official docs and schema repeatedly reinforce:

- one instance can run multiple companies
- every important object belongs to one company
- board/operator access is company-scoped

This is a good control-plane law.

### Single-assignee tasks

Paperclip is explicit:

- one issue, one assignee
- agent assignee or user assignee, not both

This is a strong anti-chaos decision.

### Org tree is first-class

Paperclip models who reports to whom.

That lets the product speak in:

- CEO
- reports
- delegation
- escalation
- hiring

This is broader than our current project, which is intentionally more runtime-oriented than org-oriented.

## Governance is not an add-on

Approvals, budgets, memberships, and board override powers are part of the center.

That is genuinely strong architecture if the product thesis includes:

- human board oversight
- agent hiring
- cost limits
- multi-user operation

## Main risk in this layer

The domain is so broad that product breadth can outrun operator closure.

This is where issues like approval discoverability and bootstrap dead-ends come from:

- the domain object exists
- the API exists
- the product loop is not always sealed

## Architect takeaway

Steal:

- company-scoped first-order entities
- persisted governance objects
- explicit org and task ownership concepts

Avoid:

- expanding the domain surface faster than the operator loop can be made trustworthy
