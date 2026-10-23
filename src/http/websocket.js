import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { parseLosslessJson, stringifyNativeJson } from '../core/json.js';
import { enumName } from '../sessions/binding.js';
import { int64, sameGuid } from '../sessions/user-data.js';
import { UserDataChangeNotifier } from '../sessions/user-data-notifier.js';
import { LibraryChangedNotifier } from '../sessions/library-changed-notifier.js';
import { RefreshProgressNotifier } from '../sessions/refresh-progress-notifier.js';
import { isEmbyClient } from './client-protocol.js';

const messageTypes = ['ForceKeepAlive', 'GeneralCommand', 'UserDataChanged', 'Sessions', 'Play', 'SyncPlayCommand', 'SyncPlayGroupUpdate', 'Playstate', 'RestartRequired', 'ServerShuttingDown', 'ServerRestarting', 'LibraryChanged', 'UserDeleted', 'UserUpdated', 'SeriesTimerCreated', 'TimerCreated', 'SeriesTimerCancelled', 'TimerCancelled', 'RefreshProgress', 'ScheduledTaskEnded', 'PackageInstallationCancelled', 'PackageInstallationFailed', 'PackageInstallationCompleted', 'PackageInstalling', 'PackageUninstalled', 'ActivityLogEntry', 'ScheduledTasksInfo', 'ActivityLogEntryStart', 'ActivityLogEntryStop', 'SessionsStart', 'SessionsStop', 'ScheduledTasksInfoStart', 'ScheduledTasksInfoStop', 'KeepAlive'];
const eventForces = { SessionStarted: true, SessionEnded: true, PlaybackStart: true, PlaybackStopped: true, PlaybackProgress: event => !event.IsAutomated, CapabilitiesChanged: true, SessionActivity: false };
const field = (value, name) => value[name];

export function attachWebSocketServer(server, { authentication, sessions, tasks, userData, users, library, refreshes, localization, configuration = {}, onError = () => {}, runBackground = operation => operation(), clock = () => Date.now() }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 0 });
  const connections = new Set();
  const connecting = new Set();
  const detaching = new Set();
  const upgradeRequests = new Set();
  const upgradeSockets = new Set();
  const controllers = new Map();
  let closed = false;
  let closePromise;
  let sessionTail = Promise.resolve();
  let taskInfoTail = Promise.resolve();
  let taskEndedTail = Promise.resolve();
  const report = error => {
    try { void Promise.resolve(onError(error)).catch(() => {}); }
    catch { /* WebSocket error reporting cannot poison the shared send tail. */ }
  };
  const requestControllerDetach = controller => {
    controller.detachRequested = true;
    if (controller.detachInFlight) return;
    const completion = Promise.withResolvers();
    const pending = completion.promise;
    controller.detachInFlight = pending;
    detaching.add(pending);
    void (async () => {
      while (controller.detachRequested) {
        controller.detachRequested = false;
        try { await controller.detach?.(); }
        catch (error) { report(error); }
      }
    })().then(completion.resolve, completion.reject);
    const settled = error => {
      detaching.delete(pending);
      controller.detachInFlight = null;
      if (error) report(error);
      if (controller.detachRequested) requestControllerDetach(controller);
    };
    void pending.then(() => settled(), settled);
  };
  const releaseConnection = connection => {
    const controller = connection.controller;
    if (!controller?.connections.delete(connection) || controller.connections.size) return;
    requestControllerDetach(controller);
  };
  const userDataChanges = userData ? new UserDataChangeNotifier({ userData, sessions, onError, runBackground }) : null;
  userDataChanges?.start();
  const libraryChanges = users && library?.on
    ? new LibraryChangedNotifier({ events: library, sessions, users, library, configuration, onError, runBackground })
    : null;
  libraryChanges?.start();
  const refreshProgress = refreshes?.on && library?.getCollectionFolders && sessions.sendMessageToAdminSessions
    ? new RefreshProgressNotifier({ refreshes, sessions, library, onError, runBackground, clock })
    : null;
  refreshProgress?.start();
  const send = (connection, messageType, data, messageId = randomUUID().replaceAll('-', '')) => new Promise((resolve, reject) => {
    if (connection.socket.readyState !== WebSocket.OPEN) { resolve(); return; }
    connection.socket.send(stringifyNativeJson({ MessageType: messageType, MessageId: messageId, Data: data }), error => error ? reject(error) : resolve());
  });
  const publishSessions = force => {
    sessionTail = sessionTail.then(async () => {
      for (const connection of connections) for (const subscription of [...connection.sessionSubscriptions]) {
        if (connection.socket.readyState !== WebSocket.OPEN || !force && BigInt(clock() - subscription.lastSent) < subscription.interval) continue;
        await localization.run(connection.locale, async () => {
          let data = await sessions.getSessions(connection.auth);
          if (connection.auth.User && !connection.auth.IsApiKey && !connection.auth.User.Policy.IsAdministrator) {
            data = data.filter(session => sameGuid(session.UserId, connection.auth.User.Id) || session.AdditionalUsers.some(user => sameGuid(user.UserId, connection.auth.User.Id)));
          }
          await send(connection, 'Sessions', data);
          subscription.lastSent = clock();
        });
      }
    }).catch(report);
  };
  const listeners = Object.entries(eventForces).map(([name, force]) => {
    const listener = event => publishSessions(typeof force === 'function' ? force(event) : force);
    sessions.on(name, listener);
    return [name, listener];
  });
  const publishTasks = force => {
    if (!tasks) return;
    taskInfoTail = taskInfoTail.then(async () => {
      const deliveries = [];
      for (const connection of connections) for (const subscription of [...connection.taskSubscriptions]) {
        if (connection.socket.readyState !== WebSocket.OPEN || !force && BigInt(clock() - subscription.lastSent) < subscription.interval) continue;
        deliveries.push(Promise.resolve().then(() => localization.run(connection.locale, async () => {
          const data = (await tasks.list()).filter(task => task.IsHidden !== true)
            .toSorted((left, right) => String(left.Name).localeCompare(String(right.Name), connection.locale.uiCulture));
          await send(connection, 'ScheduledTasksInfo', data);
          subscription.lastSent = clock();
        })).catch(report));
      }
      await Promise.all(deliveries);
    }).catch(report);
  };
  const publishTaskEnded = result => {
    if (typeof sessions.sendMessageToAdminSessions !== 'function') return;
    taskEndedTail = taskEndedTail.then(() => sessions.sendMessageToAdminSessions('ScheduledTaskEnded', result)).catch(report);
  };
  const taskListeners = tasks?.on ? [
    ['started', () => publishTasks(true)],
    ['progress', () => publishTasks(false)],
    ['completed', event => {
      publishTasks(true);
      publishTaskEnded(event.Result);
    }]
  ] : [];
  for (const [name, listener] of taskListeners) tasks.on(name, listener);
  const ended = ({ SessionInfo }) => {
    const controller = controllers.get(SessionInfo.Id);
    controllers.delete(SessionInfo.Id);
    for (const connection of controller?.connections ?? []) connection.socket.close(1000, 'System Shutdown');
  };
  sessions.on('SessionEnded', ended);
  const watch = setInterval(() => {
    for (const connection of connections) {
      const elapsed = clock() - connection.lastKeepAlive;
      if (elapsed >= 60000) connection.socket.terminate();
      else if (elapsed > 45000) send(connection, 'ForceKeepAlive', 60).catch(report);
    }
  }, 12000);
  watch.unref();

  async function connected(socket, request, auth, locale) {
    const prefix = configuration.BaseUrl?.replace(/\/$/, '') ?? '';
    const pathname = new URL(request.url, 'http://localhost').pathname.slice(prefix.length);
    const embyClient = isEmbyClient(authentication, { request, auth, embyPath: /^\/(?:emby|mediabrowser)(?:\/|$)/iu.test(pathname) });
    const connection = { socket, auth, locale, embyClient, lastActivity: clock(), lastKeepAlive: clock(),
      sessionSubscriptions: [], taskSubscriptions: [] };
    connections.add(connection);
    socket.on('error', report);
    socket.on('close', () => {
      connections.delete(connection);
      connection.sessionSubscriptions.length = 0;
      connection.taskSubscriptions.length = 0;
      releaseConnection(connection);
    });
    try {
      const session = await sessions.logActivity(auth, { remoteEndPoint: request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '' });
      // Runtime shutdown owns SessionService cleanup. An ordinary disconnect,
      // however, still has to attach/release the activity-created session so
      // the native detach path can end a controller-less session.
      if (closed) return;
      let controller = controllers.get(session.Id);
      if (!controller) {
        controller = { connections: new Set(),
          isActive() { return [...this.connections].some(value => value.socket.readyState === WebSocket.OPEN); },
          get supportsMediaControl() { return this.isActive(); },
          async sendMessage(type, id, data, { embyMessageType } = {}) {
            const target = [...this.connections].filter(value => value.socket.readyState === WebSocket.OPEN).sort((a, b) => b.lastActivity - a.lastActivity)[0];
            if (target) await localization.run(target.locale, () => send(target, target.embyClient && embyMessageType || type, data, id));
          }
        };
        controllers.set(session.Id, controller);
        controller.detach = sessions.attachController(session.Id, controller);
      }
      controller.connections.add(connection);
      connection.controller = controller;
      if (socket.readyState !== WebSocket.OPEN) { releaseConnection(connection); return; }
      socket.on('message', bytes => localization.run(locale, async () => {
        connection.lastActivity = clock();
        try {
          if (!bytes.length) { socket.close(1000); return; }
          const message = parseLosslessJson(bytes.toString('utf8'));
          if (!message || typeof message !== 'object') return;
          const type = enumName(field(message, 'MessageType') ?? 'ForceKeepAlive', messageTypes);
          if (type === 'KeepAlive') { connection.lastKeepAlive = clock(); await send(connection, 'KeepAlive'); }
          else if (type === 'SessionsStart') {
            const values = String(field(message, 'Data')).split(',');
            const delay = int64(values[0]?.trim()), interval = int64(values[1]?.trim());
            connection.sessionSubscriptions.push({ delay, interval, lastSent: 0 });
          } else if (type === 'SessionsStop') connection.sessionSubscriptions.shift();
          else if (type === 'ScheduledTasksInfoStart') {
            const values = String(field(message, 'Data')).split(',');
            const delay = int64(values[0]?.trim()), interval = int64(values[1]?.trim());
            connection.taskSubscriptions.push({ delay, interval, lastSent: 0 });
          } else if (type === 'ScheduledTasksInfoStop') connection.taskSubscriptions.shift();
        } catch (error) { report(error); }
      }));
      await send(connection, 'ForceKeepAlive', 60);
    } catch (error) { report(error); socket.close(1000, 'System Shutdown'); }
  }
  const handleUpgradeRequest = async (request, socket, head) => {
    try {
      if (closed) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      const prefix = configuration.BaseUrl?.replace(/\/$/, '') ?? '';
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (prefix && pathname.toLowerCase() !== prefix.toLowerCase() && !pathname.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      const auth = await authentication.authenticate(request);
      if (!auth.IsAuthenticated) throw Object.assign(new Error('Token is required'), { status: 403 });
      if (closed) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      const locale = localization.negotiate({ url: request.url, headers: request.headers });
      wss.handleUpgrade(request, socket, head, ws => {
        if (closed) { ws.close(1000, 'System Shutdown'); return; }
        const pending = Promise.resolve().then(() => localization.run(locale, () => connected(ws, request, auth, locale))).catch(report);
        connecting.add(pending);
        void pending.then(() => connecting.delete(pending));
      });
    } catch (error) {
      report(error);
      const status = error.status === 401 ? 403 : error.status ?? 500;
      socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Internal Server Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  };
  const upgrade = (request, socket, head) => {
    socket.on('error', report);
    upgradeSockets.add(socket);
    const pending = handleUpgradeRequest(request, socket, head);
    upgradeRequests.add(pending);
    void pending.then(() => {
      upgradeRequests.delete(pending);
      upgradeSockets.delete(socket);
    });
  };
  server.on('upgrade', upgrade);
  return {
    close() {
      if (closePromise) return closePromise;
      const completion = Promise.withResolvers();
      closePromise = completion.promise;
      // Reserve closePromise before socket/notifier callbacks can
      // synchronously re-enter close(), while closing the admission gate now.
      void (async () => {
        closed = true;
        clearInterval(watch);
        server.off('upgrade', upgrade);
        for (const socket of upgradeSockets) socket.destroy();
        for (const [name, listener] of listeners) sessions.off(name, listener);
        for (const [name, listener] of taskListeners) tasks.off?.(name, listener);
        sessions.off('SessionEnded', ended);
        const closeNotifier = notifier => Promise.resolve().then(() => notifier?.close()).catch(report);
        const userDataClosed = closeNotifier(userDataChanges);
        const libraryClosed = closeNotifier(libraryChanges);
        const refreshProgressClosed = closeNotifier(refreshProgress);
        const drainDeadline = Promise.withResolvers();
        const timeout = setTimeout(() => {
          for (const connection of connections) connection.socket.terminate();
          for (const socket of upgradeSockets) socket.destroy();
          drainDeadline.resolve();
        }, 1000);
        timeout.unref();
        // Producers are detached above, so these queues are finite. Drain every
        // accepted session/task notification while controllers still have open
        // sockets; closing connections first would silently discard queued
        // ScheduledTaskEnded messages. The same one-second deadline bounds both
        // a backpressured drain, notifier-owned lookups, and the following close
        // handshake.
        await Promise.race([
          Promise.all([
            sessionTail,
            taskInfoTail,
            taskEndedTail,
            ...upgradeRequests,
            ...connecting,
            userDataClosed,
            libraryClosed,
            refreshProgressClosed
          ]),
          drainDeadline.promise
        ]);
        for (const connection of connections) {
          if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.close(1000, 'System Shutdown');
        }
        await new Promise(resolve => wss.close(resolve));
        await Promise.race([Promise.all([...detaching]), drainDeadline.promise]);
        clearTimeout(timeout);
      })().then(completion.resolve, completion.reject);
      return closePromise;
    }
  };
}
