# Nested process ownership: NO-GO

The existing supervisor was reproduced unchanged using a new synthetic fixture, with no model request. Root → registered shell → Node → detached().unref() writer escaped. After Stop the heartbeat advanced from 4 to 31, while the acknowledgement claimed cleanupCompleted=true. The writer was PID/PGID 40956, reparented to PID 1. Only that fixture-owned group was terminated during teardown. A final numeric scan found no remaining fixture PIDs.

The local libproc probe used PROC_PIDUNIQIDENTIFIERINFO (17), whose 56-byte ABI is declared in Apple's proc_info_private.h. The leaf retained parent unique ID 22260837 after its intermediate parent was reaped. The intermediate itself then returned zero bytes/ESRCH. This supports reliable identity for a known parent but cannot reconstruct arbitrary lineage through an intermediate that exited before being observed. It does not remove the polling race.

Darwin automatic kqueue fork tracking is unavailable. The local NOTE_FORK|NOTE_TRACK registration returned an EV_ERROR receipt with ENOTSUP (45). Apple's kernel explicitly rejects NOTE_TRACK, NOTE_TRACKERR and NOTE_CHILD. NOTE_FORK also does not expose the child PID in the delivered event.

Official sources, inspected using gh at XNU commit f6217f891ac0bb64f3d375211650a4c1ff8ca1ea:

- [proc_info_private.h, ABI](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info_private.h#L45)
- [proc_internal.h, parent identity retention](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_internal.h#L287)
- [kern_event.c, unsupported tracking](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_event.c#L1105)

Artifacts: report.json (escape), feasibility.json (numeric results), lineage.c, kqueue.c, and proof.mjs with its fixture scripts. Production implementation was not expanded. Only cursor-native/README.md was updated to keep whole-session Stop explicitly blocked. Work stopped for the requested handoff.
