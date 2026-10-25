# Refresh Guide task oracle

This fixture executes the designated `RefreshGuideScheduledTask`, real
`ScheduledTaskWorker`/`TaskManager`, `ScheduledTasksController.GetTasks` and
`ScheduledTaskHelpers`. Only service counts, named Live TV configuration and the
`IGuideManager.RefreshGuide` operation are controlled. A real ordinary library
task and a declared disabled configurable task distinguish native filter rules.

The matrix changes configuration live and records complete task DTOs, errors and
configuration-read counts for every hidden/enabled filter combination. It checks
short-circuiting, including null tuner arrays and configuration failures. Real
worker runs capture Completed/Failed/Cancelled status, delegation tokens and
persisted native history. Source assemblies and input/output bytes are hashed.
Both engines' timestamps must be ordered UTC values; execution clocks and stack
text are not compared across separately executed processes.

Private native trigger/history directories and timers are disposed before their
cleanup receipt is written. Node's separate held-refresh test proves close
cancels admitted work, rejects later starts and drains the callback and trigger
owners. It reuses the generic worker's existing shutdown policy; it does not
claim timing equivalence to the native worker's two-second Dispose wait limit.

This is a task/component boundary. It does not perform Guide channel/programme
materialization, tuner/listings I/O, HTTP transport, recording or final release
acceptance. Production Guide assembly is a separate consumer scope. Run only in
the authorized Actions workflow.
