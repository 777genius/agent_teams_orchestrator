// Native observer runs OUTSIDE the LaunchServices coalition it retires.
// Build: clang -fobjc-arc -O2 -Wall -Wextra -framework Foundation
//        -framework Security -framework AppKit DarwinKernelScope.m -o opencode-v2-darwin-scope
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/poll.h>
#include <sys/wait.h>
#include <dlfcn.h>
#include <signal.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sandbox.h>
#include <crt_externs.h>
#include <spawn.h>

// Published XNU proc_info ABI. Size checks fail closed on unsupported kernels.
struct Scope { uint64_t ids[2], reserved[3]; };
struct Unique { uint8_t uuid[16]; uint64_t unique, parent; int32_t version, parentVersion; uint64_t reserved[2]; };
struct Pin { pid_t pid; struct Unique birth; struct Scope scope; int status; };
static NSString *failure;
static BOOL pin(pid_t pid, struct Pin *p) {
  struct Unique again; struct proc_bsdinfo bsd;
  p->pid=pid;
  if (proc_pidinfo(pid,17,0,&p->birth,sizeof p->birth)!=sizeof p->birth ||
      proc_pidinfo(pid,20,0,&p->scope,sizeof p->scope)!=sizeof p->scope ||
      proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&bsd,sizeof bsd)!=sizeof bsd ||
      proc_pidinfo(pid,17,0,&again,sizeof again)!=sizeof again ||
      again.unique!=p->birth.unique || again.version!=p->birth.version) return NO;
  p->status=bsd.pbi_status;
  return p->birth.unique && p->birth.version>0 && p->scope.ids[0] && p->scope.ids[1];
}
static BOOL sameScope(struct Scope a, struct Scope b) { return a.ids[0]==b.ids[0] && a.ids[1]==b.ids[1]; }
static BOOL samePin(struct Pin a, struct Pin b) { return a.pid==b.pid && a.birth.unique==b.birth.unique && a.birth.version==b.birth.version && sameScope(a.scope,b.scope); }
static int signalPin(struct Pin p, int sig) {
  struct Pin current;
  if (!pin(p.pid,&current)) { if(errno==ESRCH || errno==ENOENT) return ESRCH; return EIO; }
  if(!samePin(p,current)) return ESRCH; // The replacement receives no signal.
  audit_token_t token={{0}}; token.val[5]=(uint32_t)p.pid; token.val[7]=(uint32_t)p.birth.version;
  return proc_signal_with_audittoken(&token,sig); // Atomic pidversion lookup in kernel.
}
static BOOL counters(struct Scope scope,uint64_t *started,uint64_t *exited) {
  int (*usage)(uint64_t,void*,size_t)=dlsym(RTLD_DEFAULT,"coalition_info_resource_usage");
  uint64_t values[2]={0};
  if(!usage || usage(scope.ids[0],values,sizeof values)!=0 || values[1]>values[0]) return NO;
  *started=values[0]; *exited=values[1]; return YES;
}
static NSString *bootID(void) {
  char value[128]={0}; size_t length=sizeof value;
  if(sysctlbyname("kern.bootsessionuuid",value,&length,NULL,0)) return nil;
  return [[NSString stringWithUTF8String:value] lowercaseString];
}
static NSDictionary *identity(pid_t pid) {
  struct Pin p,again; char file[PROC_PIDPATHINFO_MAXSIZE];
  if(!pin(pid,&p) || proc_pidpath(pid,file,sizeof file)<=0) return nil;
  NSString *filePath=[[NSString stringWithUTF8String:file] stringByResolvingSymlinksInPath];
  NSString *boot=bootID();
  if(!boot || !pin(pid,&again) || !samePin(p,again)) return nil;
  return @{ @"hostPID":@(pid), @"nativePID":@(pid), @"executablePath":filePath,
    @"birth":@{@"format":@"darwin-pidversion",@"value":[NSString stringWithFormat:@"%llu:%d",p.birth.unique,p.birth.version],@"bootId":boot},
    @"coalition":@{@"resource":[NSString stringWithFormat:@"%llu",p.scope.ids[0]],@"jetsam":[NSString stringWithFormat:@"%llu",p.scope.ids[1]]} };
}
static uint64_t monotonicMS(void) { return (uint64_t)(NSProcessInfo.processInfo.systemUptime*1000); }
static NSDictionary *retire(struct Scope scope,BOOL ownSupervisor) {
  struct Pin own;
  if(!pin(getpid(),&own) || (sameScope(scope,own.scope) && !ownSupervisor)) { failure=@"cleanup_unknown"; return nil; }
  struct Pin known[8192]; size_t knownCount=0; uint64_t started=0,exited=0;
  uint64_t end=monotonicMS()+5000; BOOL closure=NO;
  while(monotonicMS()<end) {
    pid_t pids[65536]; int bytes=proc_listpids(PROC_ALL_PIDS,0,pids,sizeof pids);
    if(bytes<=0 || bytes>=(int)sizeof pids || bytes%(int)sizeof(pid_t)) break;
    size_t seen=0,stopped=0;
    for(int n=0;n<bytes/(int)sizeof(pid_t);n++) {
      struct Pin p;
      if(pids[n]<=0 || !pin(pids[n],&p) || !sameScope(scope,p.scope)) continue;
      seen++;
      if(ownSupervisor && p.pid==getpid()) { stopped++; continue; }
      size_t k=0; for(;k<knownCount;k++) if(samePin(known[k],p)) break;
      if(k==knownCount) { if(knownCount==8192) { failure=@"cleanup_unknown"; return nil; } known[knownCount++]=p; }
      if(p.status==4) stopped++;
      else { int result=signalPin(p,SIGSTOP); if(result && result!=ESRCH) { failure=@"cleanup_unknown"; return nil; } }
    }
    if(!counters(scope,&started,&exited)) break;
    // The kernel count closes the race: every currently live member is paused.
    // The app watchdog remains trusted and cannot fork while this loop runs.
    if(started-exited==seen && seen==stopped) { closure=YES; break; }
    usleep(1000);
  }
  if(!closure) { failure=@"cleanup_unknown"; return nil; }
  for(size_t k=0;k<knownCount;k++) { int r=signalPin(known[k],SIGKILL); if(r && r!=ESRCH) { failure=@"cleanup_unknown"; return nil; } }
  if(ownSupervisor) return @{ @"supervisorExitRequired":@YES }; // No empty receipt minted here.
  end=monotonicMS()+5000;
  while(monotonicMS()<end) {
    if(!counters(scope,&started,&exited)) { failure=@"cleanup_unknown"; return nil; }
    if(started==exited) return @{ @"tasksStarted":[NSString stringWithFormat:@"%llu",started],@"tasksExited":[NSString stringWithFormat:@"%llu",exited],@"empty":@YES };
    usleep(1000);
  }
  failure=@"cleanup_unknown"; return nil;
}
static BOOL writeAll(int fd,NSData *data) {
  const char *bytes=data.bytes; size_t count=data.length;
  while(count) { ssize_t n=write(fd,bytes,count); if(n<0 && errno==EINTR) continue; if(n<=0) return NO; bytes+=n; count-=n; } return YES;
}
static BOOL emit(int fd,NSDictionary *value) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  if(!data || data.length>16*1048576) return NO;
  return writeAll(fd,data) && writeAll(fd,[NSData dataWithBytes:"\n" length:1]);
}
static NSMutableDictionary<NSNumber *,NSMutableData *> *lineBuffers;
static BOOL bufferedLine(int fd) {
  NSData *data=lineBuffers[@(fd)];
  return data.length && memchr(data.bytes,'\n',data.length)!=NULL;
}
static NSDictionary *line(int fd) {
  if(!lineBuffers) lineBuffers=[NSMutableDictionary new];
  NSMutableData *data=lineBuffers[@(fd)];
  if(!data) { data=[NSMutableData data]; lineBuffers[@(fd)]=data; }
  for(;;) {
    const char *newline=data.length?memchr(data.bytes,'\n',data.length):NULL;
    if(newline) {
      NSUInteger length=(NSUInteger)(newline-(const char *)data.bytes);
      if(length>16*1048576) { [lineBuffers removeObjectForKey:@(fd)]; return nil; }
      NSData *frame=[data subdataWithRange:NSMakeRange(0,length)];
      [data replaceBytesInRange:NSMakeRange(0,length+1) withBytes:NULL length:0];
      id value=[NSJSONSerialization JSONObjectWithData:frame options:0 error:NULL];
      return [value isKindOfClass:NSDictionary.class]?value:nil;
    }
    if(data.length>16*1048576) { [lineBuffers removeObjectForKey:@(fd)]; return nil; }
    char bytes[8192]; ssize_t count=read(fd,bytes,sizeof bytes);
    if(count<0 && errno==EINTR) continue;
    if(count<=0) { [lineBuffers removeObjectForKey:@(fd)]; return nil; }
    [data appendBytes:bytes length:count];
  }
}
static int connectPath(NSString *path) {
  struct sockaddr_un address={0}; address.sun_family=AF_UNIX;
  if(strlen(path.fileSystemRepresentation)>=sizeof address.sun_path) return -1;
  strcpy(address.sun_path,path.fileSystemRepresentation);
  int fd=socket(AF_UNIX,SOCK_STREAM,0); if(fd<0) return -1;
  if(connect(fd,(struct sockaddr *)&address,sizeof address)) { close(fd); return -1; } return fd;
}
static BOOL executableHasMigrationAuthority(NSString *file) {
  SecStaticCodeRef code=NULL; CFErrorRef error=NULL;
  OSStatus status=SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:file],kSecCSDefaultFlags,&code);
  if(status==errSecCSUnsigned) return NO;
  if(status!=errSecSuccess || !code) return YES;
  CFDictionaryRef information=NULL;
  status=SecCodeCopySigningInformation(code,kSecCSSigningInformation,&information);
  NSDictionary *info=CFBridgingRelease(information);
  NSDictionary *entitlements=info[(__bridge NSString *)kSecCodeInfoEntitlementsDict];
  BOOL denied=status!=errSecSuccess || [entitlements[@"com.apple.private.coalition-spawn"] boolValue];
  if(SecStaticCodeCheckValidityWithErrors(code,kSecCSDefaultFlags,NULL,&error)!=errSecSuccess && entitlements.count) denied=YES;
  if(error) CFRelease(error); CFRelease(code); return denied;
}
static BOOL coalitionSpawnAuthorityDenied(void) {
  typedef int (*SetCoalition)(posix_spawnattr_t *,uint64_t,int,int);
  SetCoalition setCoalition=(SetCoalition)dlsym(RTLD_DEFAULT,"posix_spawnattr_setcoalition_np");
  if(!setCoalition) return NO;
  posix_spawnattr_t attributes;
  if(posix_spawnattr_init(&attributes)) return NO;
  BOOL denied=YES;
  char *arguments[]={"/usr/bin/true",NULL},*environment[]={NULL};
  // No Seatbelt applies to this supervisor. EPERM occurs before coalition lookup
  // and proves this actual LaunchServices coalition has no migration authority.
  for(int type=0;type<2;type++) {
    if(setCoalition(&attributes,UINT64_MAX,type,0)) { denied=NO; break; }
    pid_t candidate=0;
    int result=posix_spawn(&candidate,"/usr/bin/true",NULL,&attributes,arguments,environment);
    if(result==0) {
      // Never report authority denial on unexpected success; retire our own child.
      kill(candidate,SIGKILL);
      while(waitpid(candidate,NULL,0)<0 && errno==EINTR) {}
    }
    if(result!=EPERM) { denied=NO; break; }
  }
  if(posix_spawnattr_destroy(&attributes)) denied=NO;
  return denied;
}
static int application(NSString *socketPath,NSString *nonce) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp finishLaunching];
  int control=connectPath(socketPath); if(control<0) return 20;
  if(!coalitionSpawnAuthorityDenied()) { close(control); return 29; }
  if(!emit(control,@{@"kind":@"hello",@"nonce":nonce,@"identity":identity(getpid())?:@{}})) return 21;
  NSDictionary *config=line(control); if(!config) return 22;
  if(executableHasMigrationAuthority(config[@"bun"])) { close(control); return 29; }
  int ipc[2],out[2],err[2];
  if(socketpair(AF_UNIX,SOCK_STREAM,0,ipc) || pipe(out) || pipe(err)) return 23;
  pid_t child=fork(); if(child<0) return 24;
  if(child==0) {
    close(ipc[0]); close(out[0]); close(err[0]); close(control);
    if(dup2(ipc[1],3)!=3 || dup2(out[1],1)!=1 || dup2(err[1],2)!=2) _exit(25);
    // No controller handles survive exec. All descriptors beyond the IPC slot close.
    for(int fd=4;fd<getdtablesize();fd++) close(fd);
    if(chdir([config[@"cwd"] fileSystemRepresentation])) _exit(26);
    *_NSGetEnviron()=calloc(1,sizeof(char *)); NSDictionary *env=config[@"env"];
    for(NSString *key in env) setenv(key.UTF8String,[env[key] UTF8String],1);
    setenv("NODE_CHANNEL_FD","3",1); setenv("NODE_CHANNEL_SERIALIZATION_MODE","json",1);
    char *error=NULL;
    if(sandbox_init([config[@"profile"] UTF8String],0,&error)) { if(error) sandbox_free_error(error); _exit(27); }
    const char *bun=[config[@"bun"] fileSystemRepresentation],*entry=[config[@"entry"] fileSystemRepresentation];
    execl(bun,bun,entry,NULL); _exit(28);
  }
  close(ipc[1]); close(out[1]); close(err[1]);
  BOOL alive=emit(control,@{@"kind":@"spawned",@"pid":@(child)});
  NSMutableData *pending=[NSMutableData data];
  while(alive) {
    struct pollfd fds[4]={{control,POLLIN,0},{ipc[0],POLLIN,0},{out[0],POLLIN,0},{err[0],POLLIN,0}};
    BOOL cached=bufferedLine(control);
    int r=poll(fds,4,cached?0:100); if(r<0 && errno==EINTR) continue; if(r<0) break;
    if(cached) fds[0].revents|=POLLIN;
    if((fds[0].revents&(POLLHUP|POLLERR)) && !(fds[0].revents&POLLIN)) break;
    if(fds[0].revents&POLLIN) { NSDictionary *message=line(control); if(!message || !emit(ipc[0],message)) break; }
    if(fds[1].revents&POLLIN) {
      char buffer[8192]; ssize_t count=read(ipc[0],buffer,sizeof buffer);
      // IPC disconnect precedes process exit. Keep observing the held child
      // so its exit notification cannot be lost before the retirement RPC.
      if(count<=0) { close(ipc[0]); ipc[0]=-1; continue; }
      [pending appendBytes:buffer length:count]; if(pending.length>16*1048576) break;
      for(;;) {
        const char *bytes=pending.bytes; const char *newline=memchr(bytes,'\n',pending.length); if(!newline) break;
        NSUInteger length=(NSUInteger)(newline-bytes); NSData *part=[pending subdataWithRange:NSMakeRange(0,length)];
        id value=[NSJSONSerialization JSONObjectWithData:part options:NSJSONReadingFragmentsAllowed error:NULL];
        if(!value || !emit(control,@{@"kind":@"ipc",@"value":value})) { alive=NO; break; }
        [pending replaceBytesInRange:NSMakeRange(0,length+1) withBytes:NULL length:0];
      }
    }
    for(int k=2;k<4;k++) if(fds[k].revents&POLLIN) {
      char buffer[8192]; ssize_t count=read(fds[k].fd,buffer,sizeof buffer);
      if(count>0 && !emit(control,@{@"kind":k==2?@"stdout":@"stderr",@"data":[[NSData dataWithBytes:buffer length:count] base64EncodedStringWithOptions:0]})) alive=NO;
    }
    if(ipc[0]>=0 && (fds[1].revents&(POLLHUP|POLLERR)) && !(fds[1].revents&POLLIN)) { close(ipc[0]); ipc[0]=-1; }
    int status=0; if(waitpid(child,&status,WNOHANG)==child) { emit(control,@{@"kind":@"exit",@"code":@(WIFEXITED(status)?WEXITSTATUS(status):-1)}); break; }
  }
  // Controller loss: inherited scope membership provides watchdog authority.
  // This cannot manufacture the external observer's retirement proof.
  struct Pin own; if(pin(getpid(),&own)) retire(own.scope,YES);
  close(ipc[0]); close(out[0]); close(err[0]); close(control); return 0;
}
static int broker(NSString *app,NSString *socketPath,NSString *nonce) {
  int server=-1,client=-1,parent=-1,code=30;
  BOOL socketOwned=NO,scopeOwned=NO;
  struct stat socketIdentity={0},parentIdentity={0};
  struct Pin scopeOwner={0},observer={0};
  NSDictionary *retirement=nil,*appIdentity=nil;
  NSString *phase=@"configuration",*name=socketPath.lastPathComponent;
  do {
    NSDictionary *config=line(STDIN_FILENO); if(!config) break;
    phase=@"socket_path"; code=31;
    struct sockaddr_un address={0}; address.sun_family=AF_UNIX;
    if(strlen(socketPath.fileSystemRepresentation)>=sizeof address.sun_path || !name.length) break;
    NSString *parentPath=socketPath.stringByDeletingLastPathComponent;
    parent=open(parentPath.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    char retainedPath[PATH_MAX]={0};
    if(parent<0 || fstat(parent,&parentIdentity) || !S_ISDIR(parentIdentity.st_mode) ||
       parentIdentity.st_uid!=getuid() || (parentIdentity.st_mode&077) ||
       fcntl(parent,F_GETPATH,retainedPath) || ![parentPath isEqual:@(retainedPath)] || !pin(getpid(),&observer)) break;
    strcpy(address.sun_path,socketPath.fileSystemRepresentation);
    phase=@"socket_bind"; code=32;
    server=socket(AF_UNIX,SOCK_STREAM,0);
    if(server<0 || fcntl(server,F_SETFD,FD_CLOEXEC) || bind(server,(struct sockaddr *)&address,sizeof address)) break;
    if(fstatat(parent,name.fileSystemRepresentation,&socketIdentity,AT_SYMLINK_NOFOLLOW) ||
       !S_ISSOCK(socketIdentity.st_mode) || socketIdentity.st_uid!=getuid()) break;
    socketOwned=YES;
    if(chmod(socketPath.fileSystemRepresentation,0600) || listen(server,1)) break;
    phase=@"launch_services"; code=33;
    NSString *expected=[[app stringByAppendingPathComponent:@"Contents/MacOS/opencode-v2-darwin-scope"] stringByResolvingSymlinksInPath];
    NSWorkspaceOpenConfiguration *options=[NSWorkspaceOpenConfiguration configuration];
    options.createsNewApplicationInstance=YES; options.allowsRunningApplicationSubstitution=NO;
    options.activates=NO; options.addsToRecentItems=NO; options.promptsUserIfNeeded=NO;
    options.arguments=@[@"--app",socketPath,nonce]; options.environment=@{};
    dispatch_semaphore_t completed=dispatch_semaphore_create(0);
    __block NSRunningApplication *launched=nil;
    __block struct Pin launchedPin={0}; __block BOOL launchPinned=NO;
    __block NSString *launchReason=@"pending";
    [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:app] configuration:options
      completionHandler:^(NSRunningApplication *instance,NSError *error) {
        launched=instance;
        if(error) launchReason=@"launch_error";
        else if(!instance) launchReason=@"missing_instance";
        else if(instance.terminated || instance.processIdentifier<=0) launchReason=@"terminated_instance";
        else if(![instance.bundleURL.path.stringByResolvingSymlinksInPath isEqual:app.stringByResolvingSymlinksInPath]) launchReason=@"bundle_mismatch";
        else if(![instance.executableURL.path.stringByResolvingSymlinksInPath isEqual:expected]) launchReason=@"executable_mismatch";
        else if(!pin(instance.processIdentifier,&launchedPin)) launchReason=@"birth_unavailable";
        else if(launchedPin.birth.unique<=observer.birth.unique) launchReason=@"not_fresh_instance";
        else if(sameScope(launchedPin.scope,observer.scope)) launchReason=@"observer_coalition";
        else { launchReason=@"pinned"; launchPinned=YES; }
        if(error) fprintf(stderr,"darwin_launch_services_error:code=%ld\n",(long)error.code);
        dispatch_semaphore_signal(completed);
      }];
    uint64_t launchDeadline=monotonicMS()+6000;
    BOOL launchCompleted=NO;
    while(monotonicMS()<launchDeadline) {
      if(dispatch_semaphore_wait(completed,DISPATCH_TIME_NOW)==0) { launchCompleted=YES; break; }
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if(!launchCompleted || !launchPinned || !launched) {
      fprintf(stderr,"darwin_launch_result:%s\n",launchCompleted?launchReason.UTF8String:"deadline"); break;
    }
    // The trusted LaunchServices result establishes ownership BEFORE accepting
    // any untrusted peer. Its PID version and coalition must remain identical.
    scopeOwner=launchedPin; scopeOwned=YES;
    phase=@"launch_peer_wait"; code=35;
    struct pollfd ready={server,POLLIN,0}; if(poll(&ready,1,6000)!=1 || !(ready.revents&POLLIN)) break;
    client=accept(server,NULL,NULL); if(client<0) { code=36; break; }
    close(server); server=-1;
    phase=@"launch_peer_identity"; code=37;
    audit_token_t peer={{0}}; socklen_t peerLength=sizeof peer; struct Pin current;
    if(getsockopt(client,SOL_LOCAL,LOCAL_PEERTOKEN,&peer,&peerLength) || peerLength!=sizeof peer ||
       peer.val[5]!=(uint32_t)scopeOwner.pid || peer.val[7]!=(uint32_t)scopeOwner.birth.version ||
       !pin(scopeOwner.pid,&current) || !samePin(scopeOwner,current)) break;
    phase=@"launch_hello"; code=39;
    struct timeval timeout={6,0};
    if(setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout)) break;
    NSDictionary *hello=line(client); appIdentity=identity(scopeOwner.pid);
    NSString *observedBirth=[NSString stringWithFormat:@"%llu:%d",scopeOwner.birth.unique,scopeOwner.birth.version];
    if(!appIdentity || ![hello[@"kind"] isEqual:@"hello"] || ![hello[@"nonce"] isEqual:nonce] ||
       ![hello[@"identity"] isEqual:appIdentity] || ![appIdentity[@"birth"][@"value"] isEqual:observedBirth] ||
       ![appIdentity[@"executablePath"] isEqual:expected] || !pin(scopeOwner.pid,&current) || !samePin(scopeOwner,current)) break;
    timeout=(struct timeval){0,0};
    if(setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout) || !emit(client,config)) break;
    phase=@"runtime_channel";
  BOOL running=YES;
  while(running) {
    struct pollfd fds[2]={{STDIN_FILENO,POLLIN,0},{client>=0?client:-1,POLLIN,0}};
    BOOL inputCached=bufferedLine(STDIN_FILENO),clientCached=client>=0 && bufferedLine(client);
    int r=poll(fds,2,(inputCached||clientCached)?0:100); if(r<0 && errno==EINTR) continue; if(r<0) break;
    if(inputCached) fds[0].revents|=POLLIN;
    if(clientCached) fds[1].revents|=POLLIN;
    if((fds[0].revents&(POLLHUP|POLLERR)) && !(fds[0].revents&POLLIN)) break;
    if(fds[0].revents&POLLIN) {
      NSDictionary *command=line(STDIN_FILENO); if(!command) break;
      NSString *kind=command[@"kind"]; id result=nil;
      if([kind isEqual:@"send"]) { if(!emit(client,command[@"value"])) break; continue; }
      if([kind isEqual:@"identity"]) result=identity([command[@"pid"] intValue]);
      if([kind isEqual:@"retire"]) { retirement=retirement?:retire(scopeOwner.scope,NO); result=retirement; running=NO; }
      if(!emit(STDOUT_FILENO,@{@"kind":@"reply",@"id":command[@"id"]?:@0,@"value":result?:NSNull.null,@"error":result?NSNull.null:(failure?:@"execution_identity_mismatch")})) break;
    }
    if(fds[1].revents&POLLIN) {
      NSDictionary *event=line(client);
      if(!event) { retirement=retire(scopeOwner.scope,NO); close(client); client=-1; if(!retirement) break; continue; }
      if([event[@"kind"] isEqual:@"spawned"]) {
        pid_t pid=[event[@"pid"] intValue]; struct Pin child;
        NSDictionary *childIdentity=nil;
        struct Pin born;
        if(!pin(pid,&born) || !sameScope(scopeOwner.scope,born.scope)) { phase=@"child_birth"; break; }
        // Actual selected Seatbelt policy compilation takes ~1s before exec.
        // Retain unique process identity through exec (PID version changes),
        // refuse PID reuse/coalition movement, and never wait without a bound.
        uint64_t childDeadline=monotonicMS()+6000;
        while(monotonicMS()<childDeadline) {
          struct Pin current;
          if(!pin(pid,&current) || current.birth.unique!=born.birth.unique ||
             !sameScope(scopeOwner.scope,current.scope) || current.status==5) break;
          childIdentity=identity(pid);
          if([childIdentity[@"executablePath"] isEqual:config[@"bun"]]) break;
          usleep(1000);
        }
        if(!pin(pid,&child) || child.birth.unique!=born.birth.unique || !sameScope(scopeOwner.scope,child.scope) || !childIdentity || ![childIdentity[@"executablePath"] isEqual:config[@"bun"]]) { phase=@"child_exec_identity"; break; }
        NSString *observedBirth=[NSString stringWithFormat:@"%llu:%d",child.birth.unique,child.birth.version];
        if(![childIdentity[@"birth"][@"value"] isEqual:observedBirth]) { phase=@"child_birth_changed"; break; }
        event=@{@"kind":@"mapping",@"supervisor":appIdentity,@"bun":childIdentity};
      }
      if(!emit(STDOUT_FILENO,event)) break;
      // Drain queued ACK/exit events before accepting a simultaneous HUP.
      continue;
    }
    if(fds[1].revents&(POLLHUP|POLLERR)) {
      retirement=retire(scopeOwner.scope,NO);
      close(client); client=-1;
      if(!retirement) break;
    }
  }
  if(running) { retirement=retirement?:retire(scopeOwner.scope,NO); code=40; }
  else code=failure?40:0;
  } while(0);
  if(client>=0) close(client);
  if(server>=0) close(server);
  if(socketOwned) {
    struct stat current;
    if(fstatat(parent,name.fileSystemRepresentation,&current,AT_SYMLINK_NOFOLLOW)==0) {
      if(S_ISSOCK(current.st_mode) && current.st_uid==getuid() && current.st_dev==socketIdentity.st_dev && current.st_ino==socketIdentity.st_ino) {
        if(unlinkat(parent,name.fileSystemRepresentation,0)) code=40;
      } else code=40; // A replacement is never unlinked.
    } else if(errno!=ENOENT) code=40;
  }
  if(parent>=0) close(parent);
  if(scopeOwned && !retirement) { retirement=retire(scopeOwner.scope,NO); if(!retirement) code=40; }
  if(code) fprintf(stderr,"darwin_broker_failure:%s:code=%d\n",phase.UTF8String,code);
  return code;
}
int main(int argc,char **argv) { @autoreleasepool {
  signal(SIGPIPE,SIG_IGN);
  if(argc==2 && !strcmp(argv[1],"--platform")) {
    char build[256]={0},release[256]={0}; size_t buildSize=sizeof build,releaseSize=sizeof release;
    if(sysctlbyname("kern.osversion",build,&buildSize,NULL,0) || sysctlbyname("kern.osrelease",release,&releaseSize,NULL,0) ||
       !buildSize || buildSize>sizeof build || !releaseSize || releaseSize>sizeof release ||
       build[buildSize-1]!=0 || release[releaseSize-1]!=0) return 2;
    return emit(STDOUT_FILENO,@{@"osBuild":@(build),@"kernelRelease":@(release)})?0:3;
  }
  if(argc==3 && !strcmp(argv[1],"--identity")) { errno=0; NSDictionary *v=identity(atoi(argv[2])); if(!v && (errno==ESRCH || errno==ENOENT)) v=@{@"absent":@YES}; if(!v) return 2; return emit(STDOUT_FILENO,v)?0:3; }
  if(argc==3 && !strcmp(argv[1],"--migration-authority")) return emit(STDOUT_FILENO,@{@"denied":@(executableHasMigrationAuthority([NSString stringWithUTF8String:argv[2]]))})?0:3;
  if(argc==4 && !strcmp(argv[1],"--app")) return application([NSString stringWithUTF8String:argv[2]],[NSString stringWithUTF8String:argv[3]]);
  if(argc==5 && !strcmp(argv[1],"--broker")) return broker([NSString stringWithUTF8String:argv[2]],[NSString stringWithUTF8String:argv[3]],[NSString stringWithUTF8String:argv[4]]);
  if(argc==2 && !strcmp(argv[1],"--version")) { puts("opencode-v2-darwin-scope/1"); return 0; }
  return 64;
} }
