import {expect,mock,test} from 'bun:test'
mock.module('./OpenCodeV2ProviderManagement.js',()=>({selectedOpenCodeV2Version:async()=>null,buildOpenCodeV2KeySetupForm:()=>null,inspectOpenCodeReadSelection:async()=>{throw Error('selection_unavailable')},selectedProviderUsesOpenCodeV2:async()=>{throw Error('selection_unavailable')},connectOpenCodeV2Provider:async()=>{throw Error('native effect forbidden')},loadOpenCodeV2ProviderModels:async()=>{throw Error('native effect forbidden')},testOpenCodeV2ProviderModel:async()=>{throw Error('native effect forbidden')}}))
const {OpenCodeProviderManagementAdapter}=await import('./OpenCodeProviderManagementAdapter.js')
test('selection failures return provider results for catalog, connect and model tests without legacy acquisition',async()=>{
 let reads=0;const adapter=new OpenCodeProviderManagementAdapter({inventoryService:{probe:async()=>{reads++;throw Error('legacy fallback forbidden')}}});
 const input={runtimeId:'opencode' as const,providerId:'groq'};
 const results=await Promise.all([adapter.loadModels(input),adapter.connectProvider({...input,method:'api',apiKey:'TEST'}),adapter.testModel({...input,modelId:'TEST'})]);
 for(const result of results){expect(result.ok).toBe(false);if(!result.ok){expect(result.error.code).toBe('runtime-unhealthy');expect(result.error.recoverable).toBe(true)}}expect(reads).toBe(0)
})
