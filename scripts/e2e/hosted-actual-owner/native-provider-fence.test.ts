import { expect, test } from 'bun:test'
import { combineNativeProviderFences } from './native-provider-fence.js'

test('activation or profile/root loss before synchronous consumption drains every retained token', async () => {
  for (const loss of ['profile','activation','throw'] as const) {
    let profileCurrent = true, activationCurrent = true, consumed = 0, revoked = false
    const fence = combineNativeProviderFences([
      {consume(){consumed++;if(loss === 'throw') throw new Error('revoked');return activationCurrent}},
      {consume(){consumed++;return true}},
    ],()=>profileCurrent,()=>{revoked=true})
    await Promise.resolve()
    if(loss === 'profile') profileCurrent=false
    if(loss === 'activation') activationCurrent=false
    expect(fence.consume()).toBe(false)
    expect(consumed).toBe(2)
    expect(revoked).toBe(true)
    expect(fence.consume()).toBe(false)
    expect(consumed).toBe(2)
  }
})
test('currentness is observed again after retained token consumption', () => {
  let current=true
  const fence=combineNativeProviderFences([{consume(){current=false;return true}}],()=>current,()=>{})
  expect(fence.consume()).toBe(false)
})
