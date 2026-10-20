import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, chmod, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectOpenCodeReadSelection, selectedOpenCodeReadPath } from './OpenCodeNativeIdentity.js'

test.skipIf(process.platform === 'win32')('blank and stale overrides retain the valid legacy fallback as the one selected executable', async () => {
 const root=await mkdtemp(path.join(tmpdir(),'TEST-selection-')), env={...process.env}
 try {
  const binary=path.join(root,'opencode');await writeFile(binary,`#!${process.execPath}\nconsole.log("1.18.34")\n`);await chmod(binary,0o700);
  process.env.OPENCODE_BIN_PATH=binary;
  for(const override of ['',path.join(root,'missing')]){process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=override;expect(selectedOpenCodeReadPath()).toBe(binary);const selected=await inspectOpenCodeReadSelection();expect(selected.path).toBe(binary);expect(selected.policy).toEqual({generation:'v1',version:'1.18.34'});expect(selected.native).toBeNull()}
 }finally{process.env=env;await rm(root,{recursive:true,force:true})}
})

test.skipIf(process.platform === 'win32')('V1 env-node wrapper is probed through its resolved loader in private roots', async () => {
 const root=await mkdtemp(path.join(tmpdir(),'TEST-node-wrapper-')), env={...process.env}, executable=process.execPath
 try {
  const loaders=path.join(root,'loaders');await mkdir(loaders);await symlink(process.env.TEST_NODE!,path.join(loaders,'node'));
  const binary=path.join(root,'opencode');await writeFile(binary,'#!/usr/bin/env node\nif(!process.env.HOME.includes("opencode-v2-read-")||process.env.TEST_SECRET)process.exit(2);console.log("1.18.34")\n');await chmod(binary,0o700);
  process.env.PATH=[loaders,'/usr/bin','/bin'].join(path.delimiter);process.env.TEST_SECRET='TEST-private';process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=binary;delete process.env.OPENCODE_BIN_PATH;
  // Simulate a Bun installation without a sibling Node binary.
  Object.defineProperty(process,'execPath',{value:path.join(root,'without-node/bun'),configurable:true});
  const selection=await inspectOpenCodeReadSelection();expect(selection.policy).toEqual({generation:'v1',version:'1.18.34'});expect(selection.native).toBeNull();expect(selection.path).toBe(binary);
  await writeFile(binary,'#!/usr/bin/env node\nconsole.log("opencode v2.0.32")\n');
  await expect(inspectOpenCodeReadSelection()).rejects.toThrow();
 }finally{Object.defineProperty(process,'execPath',{value:executable,configurable:true});process.env=env;await rm(root,{recursive:true,force:true})}
},15000)


test.skipIf(process.platform === 'win32')('valid primary override ignores a lower-precedence relative override', async () => {
 const root=await mkdtemp(path.join(tmpdir(),'TEST-primary-selection-')),env={...process.env}
 try {
  const binary=path.join(root,'opencode');await writeFile(binary,`#!${process.execPath}\nconsole.log("1.18.34")\n`);await chmod(binary,0o700);
  process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=binary;process.env.OPENCODE_BIN_PATH='relative/unused-opencode';
  expect(selectedOpenCodeReadPath()).toBe(binary);
  const selection=await inspectOpenCodeReadSelection();expect(selection.path).toBe(binary);expect(selection.policy).toEqual({generation:'v1',version:'1.18.34'});
  process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH=path.join(root,'missing');
  expect(()=>selectedOpenCodeReadPath()).toThrow('identity_mismatch');
 } finally {process.env=env;await rm(root,{recursive:true,force:true})}
})
