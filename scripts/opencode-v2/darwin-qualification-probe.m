#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern int sandbox_check(pid_t, const char *, int, ...);
static OSErr handle(const AppleEvent *event, AppleEvent *reply, SRefCon ref) {
  (void)event; (void)reply; (void)ref; return noErr;
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "--target")) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    AEInstallEventHandler(kCoreEventClass, kAEGetData, NewAEEventHandlerUPP(handle), 0, false);
    printf("%d\n", getpid()); fflush(stdout);
    [NSApp run]; return 0;
  }
  if (!strcmp(argv[1], "--mach")) {
    mach_port_t service = MACH_PORT_NULL;
    int code = bootstrap_look_up(bootstrap_port, "com.apple.coreservices.launchservicesd", &service);
    if (service) mach_port_deallocate(mach_task_self(), service);
    printf("{\"code\":%d}\n", code); return 0;
  }
  if (!strcmp(argv[1], "--appleevent") && argc == 3) {
    pid_t pid = atoi(argv[2]); AEAddressDesc target = {typeNull,NULL}; AppleEvent event = {typeNull,NULL};
    OSStatus code = AECreateDesc(typeKernelProcessID, &pid, sizeof(pid), &target);
    if (!code) code = AECreateAppleEvent(kCoreEventClass, kAEGetData, &target, kAutoGenerateReturnID, kAnyTransactionID, &event);
    if (!code) code = AESendMessage(&event, NULL, kAENoReply | kAENeverInteract, 60);
    AEDisposeDesc(&event); AEDisposeDesc(&target);
    printf("{\"code\":%d,\"sandboxDenied\":%d}\n", code, sandbox_check(getpid(), "appleevent-send", 0)); return 0;
  }
  return 2;
}
