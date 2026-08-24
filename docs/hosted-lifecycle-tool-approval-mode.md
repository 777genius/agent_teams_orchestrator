# Hosted lifecycle tool approval mode

The privately admitted lifecycle launch plan uses schema version 2 and requires
`toolApprovalMode` with the exact value `manual` or `auto`. The field is covered
by the raw-plan generation, runtime plan fingerprint, and durable state. Legacy
plans and persisted lifecycle state without the field fail closed.

The OpenCode lifecycle lane always sends the explicit mode on its launch wire.
`manual` is paired with `skipPermissions: false`; `auto` is paired with
`skipPermissions: true`. Contradictory explicit values are rejected. The bridge
continues to understand legacy callers at its creation boundary, but canonical
hosted lifecycle creation never relies on that default.
