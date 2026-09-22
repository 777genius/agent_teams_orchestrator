# Noninteractive Control Plane And Automation Gaps

## The good story on paper

Paperclip wants one API with different actors:

- board
- board API key
- agent API key
- agent JWT

That is the right conceptual direction.

It is much better than products that hard-separate UI API and agent API with no shared vocabulary.

## What the deeper pass clarified

The weak seam is not "missing auth".

The weak seam is:

- strong interactive board control
- weaker non-interactive operator automation story

## Where the gap shows up

### Board powers are still a distinct class

A lot of routes still fundamentally assume board identity.

That is not wrong.

But it means Paperclip today is much stronger for:

- human-supervised board operation

than for:

- trusted external operator bots
- secretary/mediator agents
- non-browser company automation

Issue `#1177` is the clearest user-language expression of this gap.

### Plugin execution routes still show product/runtime disagreement

Issue `#3271` is the most concrete example.

The product story says plugin tools are an execution-side extensibility surface.

But current routes still front-load:

- `assertBoardOrgAccess(req)`

on:

- `GET /plugins/tools`
- `POST /plugins/tools/execute`

and only later apply company-scoped checks.

That means the runtime capability exists in concept, but the route personality is still board-first.

### `local_trusted` is convenience, not a general automation model

Local implicit board mode is very useful for development and local operator ergonomics.

But it is not the same thing as:

- revocable automation credentials
- auditable non-browser operator identity
- scoped company automation roles

That distinction matters.

Otherwise the product can look more automation-ready than it really is.

## Why this matters

If the long-term story is "company OS", then eventually there are three very different actors:

- human board operator
- autonomous company agent
- trusted external control-plane mediator

Paperclip is already pretty strong on the first two.

The third is still much softer.

That is a useful competitor lesson because many advanced users will want exactly that mediator pattern:

- parse human intent outside the board UI
- create/assign/update work non-interactively
- still preserve audit and governance

## Architect takeaway

Steal:

- explicit distinction between human board identity and agent identity
- one shared API vocabulary for different actor classes

Avoid:

- implying that board-centered product breadth automatically equals automation-ready control-plane access
- leaving trusted operator-bot capability as an undocumented grey zone
- letting execution-side surfaces inherit board-first route personalities forever
