/**
 * Exact planJson emitted by Product projector f7e729c48f41c1ed6675d99a5b0c2dec93595775,
 * test "projects repeated provider lanes, interleaved ordinals and a later primary".
 * Captured by executing that real projector test; do not reformat.
 * UTF-8 SHA-256: feb3a9cc2bdd6e5dda07b545570e38616a5b68c1a264bb01034138b5a678380f
 */
export const PRODUCT_SCHEMA3_INTERLEAVED_PLAN_JSON = '{"schemaVersion":3,"workspaceId":"workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","teamId":"team_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workspaceRoot":"/srv/workspaces/project","toolApprovalMode":"auto","runtimePlanRef":{"teamId":"team_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runId":"run_cccccccccccccccccccccccccccccccc","generation":19,"planHash":"sha256:c39a70d448298729bcb10fabfc2503a5e16faa07656909c075b981fd79942834"},"primaryOrdinal":2,"lanes":[{"laneId":"lane_11111111111111111111111111111111","kind":"opencode","provider":"opencode","selectedModel":"openai/gpt-6","members":[{"name":"open-a","prompt":"A.","ordinal":1,"agentId":"member_11111111111111111111111111111111"},{"name":"open-b","prompt":"B.","model":"google/gemini-3.1-pro","effort":"high","ordinal":2,"agentId":"member_44444444444444444444444444444444"}]},{"laneId":"lane_22222222222222222222222222222222","kind":"opencode","provider":"opencode","selectedModel":"anthropic/claude-sonnet-4-6","effort":"low","members":[{"name":"open-c","prompt":"C.","ordinal":0,"agentId":"member_66666666666666666666666666666666"}]}]}'
export const PRODUCT_SCHEMA3_INTERLEAVED_PLAN_SHA256 =
  'feb3a9cc2bdd6e5dda07b545570e38616a5b68c1a264bb01034138b5a678380f'
