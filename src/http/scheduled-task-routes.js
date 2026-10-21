import { booleanValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { bindTaskTriggerInfos } from '../tasks/scheduled-task-binding.js';

function filter(context, name) {
  const value = queryValue(context.query, name);
  return value === undefined ? undefined : booleanValue(value, name);
}

function triggerBody(value, source) {
  return bindTaskTriggerInfos(value, source);
}

export function registerScheduledTaskRoutes(add, { tasks, onError = () => {} }) {
  const required = () => {
    if (!tasks) throw httpError(501, 'Scheduled tasks are not configured.');
    return tasks;
  };
  const report = error => {
    try { void Promise.resolve(onError(error)).catch(() => {}); }
    catch { /* Background reporting cannot change an acknowledged response. */ }
  };

  add('GET', '/ScheduledTasks', context => required().list({
    isHidden: filter(context, 'isHidden'),
    isEnabled: filter(context, 'isEnabled')
  }), { policy: 'RequiresElevation' });

  add('GET', '/ScheduledTasks/{taskId}', async context => await required().get(context.params.taskId) ?? notFound(), {
    policy: 'RequiresElevation'
  });

  add('POST', '/ScheduledTasks/Running/{taskId}', context => {
    const manager = required();
    if (!manager.has(context.params.taskId)) return notFound();
    let execution;
    try { execution = manager.execute(context.params.taskId); }
    catch (error) {
      // Native starts this worker fire-and-forget, so an already-running task
      // still produces the controller's acknowledged response.
      if (error?.code === 'task-running') return noContent();
      throw error;
    }
    void Promise.resolve(execution).catch(report);
    return noContent();
  }, { policy: 'RequiresElevation' });

  add('DELETE', '/ScheduledTasks/Running/{taskId}', context => {
    const manager = required();
    if (!manager.has(context.params.taskId)) return notFound();
    let cancellation;
    try { cancellation = manager.cancel(context.params.taskId); }
    catch (error) {
      // ScheduledTaskWorker.Cancel throws InvalidOperationException when the
      // task is Idle or Cancelling; ExceptionMiddleware exposes that as 500.
      if (error?.code === 'task-not-running') throw new Error(error.message, { cause: error });
      throw error;
    }
    void Promise.resolve(cancellation).catch(report);
    return noContent();
  }, { policy: 'RequiresElevation' });

  add('POST', '/ScheduledTasks/{taskId}/Triggers', async context => {
    const manager = required();
    if (!manager.has(context.params.taskId)) return notFound();
    await manager.updateTriggers(context.params.taskId, context.body);
    return noContent();
  }, { policy: 'RequiresElevation', body: true, bindBody: triggerBody, bodyParameter: 'triggerInfos' });
}
