import { expect, test } from 'bun:test'

// A separate JS runtime isolates builtin capture and official module singletons.
// Only the actual current official route graph is used. All paths are fresh
// TEST state; command spawning and non-loopback networking fail closed.
for (const mode of ['baseline', 'missing-legacy-replacement', 'missing-replacement', 'missing-bundled-replacement'] as const)
test(`actual current official location graph exercises ${mode} filesystem wiring`, async () => {
  const script = `
    const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
    const root = await fs.promises.mkdtemp(path.join(process.env.TMPDIR, 'TEST-location-graph-'));
    const project = path.join(root, 'project');
    const globalPaths = Object.fromEntries(['home','data','cache','config','state','tmp','bin','log','repos'].map(key => [key,path.join(root,key)]));
    await Promise.all([project,...Object.values(globalPaths)].map(dir=>fs.promises.mkdir(dir,{recursive:true,mode:448})));
    for(const [key,value] of Object.entries({HOME:globalPaths.home,USERPROFILE:globalPaths.home,XDG_CONFIG_HOME:globalPaths.config,XDG_DATA_HOME:globalPaths.data,XDG_CACHE_HOME:globalPaths.cache,XDG_STATE_HOME:globalPaths.state,TMPDIR:globalPaths.tmp,TMP:globalPaths.tmp,TEMP:globalPaths.tmp,OPENCODE_CONFIG_DIR:globalPaths.config}))process.env[key]=value;
    const nativeCallback=fs.realpath, nativePromise=fs.promises.realpath.bind(fs.promises);
    const original=Object.assign(new Error('TEST-forced-captured-callback'),{code:'EPERM',syscall:'realpath'});
    let callbackCalls=0, promiseCalls=[], missingCalls=0, commandCalls=0, remoteCalls=0;
    fs.realpath=(input,...args)=>process.argv[1].startsWith('missing')||input===project?(callbackCalls++,queueMicrotask(()=>args.at(-1)(original))):nativeCallback(input,...args);
    await import('node:fs');
    fs.promises.realpath=input=>input===project?Promise.reject(original):nativePromise(input);
    await import('node:fs/promises');
    fs.realpath=nativeCallback;
    require('node:module').syncBuiltinESMExports();
    const selected=path.dirname(Bun.resolveSync('@opencode/server/options',process.cwd()));
    const load=s=>import(pathToFileURL(Bun.resolveSync(s,selected)).href);
    const effect=await load('effect'), {Effect,Layer,FileSystem,PlatformError,Scope,Exit,Context}=effect;
    const platform=await load('@opencode/util/effect/app-node-platform');
    const routes=await load('@opencode/server/routes'), global=await load('@opencode/util/global');
    const cross=await load('@opencode/util/cross-spawn-spawner');
    const spawn=await load('effect/process/ChildProcessSpawner');
    const http=await load('@effect/platform-node/NodeHttpServer'), httpTypes=await load('effect/http');
    const helpers=await import('./src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.ts');
    const addresses=await import('./src/services/opencode/host/OpenCodeV2ServerAddress.ts');
    const failures=await import('./src/services/opencode/execution/OpenCodeV2ServerFailure.ts');
    const source=await Bun.file('./src/services/opencode/host/windows/OpenCodeV2WindowsRuntime.ts').text();
    let sourceAdapter=source.slice(source.indexOf('const filesystemNode ='),source.indexOf('\\n  const error ='));
    if(process.argv[1]==='missing-legacy-replacement'){
      const begin=sourceAdapter.indexOf('// Config discovery'),end=sourceAdapter.indexOf('        return error',begin);
      if(begin<0||end<begin)throw new Error('TEST-legacy-baseline-missing');
      sourceAdapter=sourceAdapter.slice(0,begin)+sourceAdapter.slice(end);
    }
    const adapterBody=new Bun.Transpiler({loader:'ts'}).transformSync(sourceAdapter);
    const filesystem={realpath:input=>{promiseCalls.push(input);return nativePromise(input).catch(error=>{if(error.code==='ENOENT')missingCalls++;throw error})}};
    let filesystemNode;
    if(process.argv[1].includes('bundled')){
      const entry=path.join(root,'adapter.ts'),outfile=path.join(root,'adapter.js');
      await fs.promises.writeFile(entry,"import filesystem from 'node:fs/promises';import {types} from 'node:util';import {readWindowsRealpathFailure,retainWindowsRealpathFailure} from "+JSON.stringify(path.resolve('src/services/opencode/host/windows/OpenCodeV2WindowsRealpath.ts'))+";export function bind(effect:any,platform:any){const {Effect,Layer,FileSystem,PlatformError}=effect;"+sourceAdapter+";return filesystemNode}");
      const compiler=process.env.TEST_OPENCODE_V2_BUNDLE_COMPILER||process.execPath;
      const build=Bun.spawnSync([compiler,'build',entry,'--target','bun','--format','esm','--minify','--packages','bundle','--outfile',outfile]);
      if(build.exitCode!==0)throw new Error('TEST-adapter-build-failed '+build.stderr.toString());
      // Import before installing the live wrapper, as the release entry does.
      const bundled=await import(pathToFileURL(outfile).href);
      fs.promises.realpath=filesystem.realpath;
      require('node:module').syncBuiltinESMExports();
      filesystemNode=bundled.bind(effect,platform);
    }else{
      filesystemNode=new Function('platform','Effect','Layer','FileSystem','PlatformError','filesystem','types','retainWindowsRealpathFailure','readWindowsRealpathFailure',adapterBody+';return filesystemNode;')(
        platform,Effect,Layer,FileSystem,PlatformError,filesystem,require('node:util').types,helpers.retainWindowsRealpathFailure,helpers.readWindowsRealpathFailure);
    }
    const databasePath=path.join(globalPaths.data,'opencode.db'),configDirectory=globalPaths.config;
    const requireValue=value=>{if(!value)throw new Error('TEST-production-composition-refused')};
    const spawner=spawn.make(()=>{commandCalls++;return Effect.fail(effect.PlatformError.systemError({_tag:'PermissionDenied',module:'ChildProcess',method:'spawn'}))});
    let createBody=source.slice(source.indexOf('function createRoutes('),source.indexOf('\\n  async function start('));
    if(process.argv[1]==='baseline')createBody=createBody.replace(', platform.filesystem.replace(filesystemNode)','');
    createBody=new Bun.Transpiler({loader:'ts'}).transformSync(createBody);
    const createRoutes=new Function('requireValue','databasePath','configDirectory','routes','cross','Layer','spawn','spawner','global','globalPaths','platform','filesystemNode',createBody+';return createRoutes;')(
      requireValue,databasePath,configDirectory,routes,cross,Layer,spawn,spawner,global,globalPaths,platform,filesystemNode);
    const nativeFetch=globalThis.fetch;
    globalThis.fetch=Object.assign((input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(u.hostname!=='127.0.0.1'){remoteCalls++;return Promise.reject(new Error('TEST-network-refused'))}return nativeFetch(input,init)}, {preconnect:nativeFetch.preconnect});
    const password='x'.repeat(43),scope=await Effect.runPromise(Scope.make());
    let cause, result;
    try {
      const origin=await Effect.runPromise(Effect.gen(function*(){
        const node=require('node:http').createServer();
        const server=yield* http.make(()=>node,{host:'127.0.0.1',port:0,gracefulShutdownTimeout:'1 second'});
        yield* Effect.addFinalizer(()=>Effect.sync(()=>node.closeAllConnections()));
        const url=addresses.openCodeV2ServerLoopbackUrl('2.0.32',server.address);
        const options={password,hostname:'127.0.0.1',port:0,app:{name:'TEST-location',version:'2.0.32'},database:{path:databasePath},events:{persist:true},config:{directory:configDirectory,project:true,content:JSON.stringify({update:'disable',share:'disabled',snapshots:false,warming:false,plugins:[]})},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false}};
        const services=yield* Layer.build(createRoutes(options,()=>[url]).pipe(Layer.provideMerge(http.layerHttpServices)));
        const handler=Context.get(services,httpTypes.HttpRouter.HttpRouter).asHttpEffect().pipe(Effect.tapCause(value=>Effect.sync(()=>{cause=failures.projectOpenCodeV2LocationCause(value)})),Effect.provide(services));
        yield* server.serve(handler).pipe(Effect.provide(http.layerHttpServices));return url;
      }).pipe(Effect.provideService(Scope.Scope,scope)));
      const url=new URL('/api/location',origin);url.searchParams.set('location[directory]',project);
      const response=await fetch(url,{headers:{authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')}});
      const text=await response.text();let directory;try{directory=JSON.parse(text).directory}catch{}
      result={status:response.status,directoryMatches:directory===project,callbackCalls,promiseProjectCalls:promiseCalls.filter(x=>x===project).length,missingCalls,remoteCalls,commandCalls,cause};
    } finally {await Effect.runPromise(Scope.close(scope,Exit.void));fs.realpath=nativeCallback;fs.promises.realpath=nativePromise;globalThis.fetch=nativeFetch;await fs.promises.rm(root,{recursive:true,force:true})}
    console.log('TEST-RESULT '+JSON.stringify(result));
  `
  const child = Bun.spawn([process.execPath, '-e', script, mode], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 12_000)
  const [output, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  expect(await child.exited, stderr).toBe(0)
  const line = output.split('\n').find(value => value.startsWith('TEST-RESULT '))
  expect(line, stderr + output).toBeDefined()
  const result = JSON.parse(line!.slice('TEST-RESULT '.length))
  expect(result.callbackCalls).toBeGreaterThan(0)
  expect(result.remoteCalls).toBe(0)
  if (mode === 'baseline' || mode === 'missing-legacy-replacement') {
    expect(result.status).toBe(500)
    if (mode === 'baseline') expect(result.promiseProjectCalls).toBe(0)
    expect(result.cause).toMatchObject({ kind: 'Die', tag: 'PlatformError', method: 'realPath', errno: 'EPERM' })
    if (mode === 'missing-legacy-replacement') expect(result.missingCalls).toBeGreaterThan(0)
  } else {
    expect(result.promiseProjectCalls).toBeGreaterThan(0)
    expect(result.status).toBe(200); expect(result.directoryMatches).toBe(true)
    expect(result.missingCalls).toBeGreaterThan(0)
  }
}, 15_000)
