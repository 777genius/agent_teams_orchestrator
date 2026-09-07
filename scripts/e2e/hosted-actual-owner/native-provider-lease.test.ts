import {expect,test} from 'bun:test'
import {matchesNativeLifecycleLease} from './native-provider-lease.js'
import type {HostedApprovalRuntimeRoute} from '../../../src/services/hostedControl/HostedApprovalRuntimeAdmission.js'
test('ordinary leases are scoped to actual admitted run or session without a preflight prefix exception',()=>{
  const route={memberName:'worker',authority:{teamId:'team_a',laneId:'primary',runId:'run_a',sessionId:'ses_a'}} as HostedApprovalRuntimeRoute
  const lease={teamId:'team_a',laneId:'primary',memberName:'worker',runId:'run_a'}
  expect(matchesNativeLifecycleLease(lease,route)).toBe(true)
  expect(matchesNativeLifecycleLease({...lease,runId:null,sessionId:'ses_a'},route)).toBe(true)
  for(const delta of [{teamId:'__opencode_preflight__'},{teamId:'team_b'},{laneId:'secondary'},
    {memberName:'other'},{runId:'run_b'},{runId:null},{sessionId:'ses_b'}]) {
    expect(matchesNativeLifecycleLease({...lease,...delta},route)).toBe(false)
  }
})
