// Generation-specific, whole-output parsing grounded in actual pinned native CLI output.
// Display helpers that extract a semver substring cannot authorize native qualification.
export function parseNativeVersion(generation:string, output:string) {
  const stable='(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
  const expression=generation==='v1'?`^${stable}$`:generation==='v2'?`^opencode v${stable}$`:null;
  if(!expression)throw new Error('unknown native generation');
  const text=output.trim();if(!new RegExp(expression).test(text))throw new Error('invalid exact native version output');
  const version=generation==='v1'?text:text.slice('opencode v'.length);
  if(!version.startsWith(generation==='v1'?'1.':'2.'))throw new Error('native generation/version mismatch');
  return version;
}
export function successfulHelp(generation:string, command:{code:number|null;expired:boolean;stdout:string;stderr:string}) {
  if(command.code!==0||command.expired)throw new Error('successful native help required');
  const text=generation==='v1'?command.stderr:generation==='v2'?command.stdout:null;
  if(text===null)throw new Error('unknown native generation');
  if(!text.trim())throw new Error('empty native help stream');
  return text;
}
