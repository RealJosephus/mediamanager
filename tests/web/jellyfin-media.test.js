import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

const enabled = process.env.MEDIAMANAGER_JELLYFIN_WEB_ROOT && process.env.MEDIAMANAGER_BROWSER_EXECUTABLE
  && process.env.MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE && process.env.MEDIAMANAGER_TEST_POSTGRES;
const requestPath = value => {
  const url = new URL(value);
  return { origin: url.origin, path: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() };
};

test('designated Jellyfin Web browses scanned media and retains favorites, watched state and a playlist after production restart', {
  skip: !enabled, timeout: 360000
}, async t => {
  const output = path.join(validationOutputRoot(), `jellyfin-media-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const report = { steps: [], requests: [], pageErrors: [], consoleErrors: [], cleanup: [], preparation: {}, webSockets: [], transitions: [] };
  let fixture, client, browser, page, failure;
  const sanitize = text => {
    for (const secret of fixture?.secrets ?? [process.env.MEDIAMANAGER_TEST_POSTGRES]) {
      if (secret) text = text.replaceAll(secret, '[credential redacted]');
    }
    return text.replace(/([?&](?:api_key|token|sign)=)[^&\s"']+/giu, '$1[redacted]');
  };
  try {
    const browserSupply = await browserInputs();
    const web = await jellyfinWebInputs();
    report.client = { sourceHead: web.receipt.sourceHead, runtime: web.receipt.runtimeManifest.sha256 };
    report.browser = { revision: browserSupply.revision, version: browserSupply.browserVersion };
    fixture = await createWebServerFixture({ populated: true, preparation: report.preparation, signal: t.signal });
    report.source = fixture.source;
    report.media = fixture.media;
    client = await serveWebClient(web.runtime);
    assert.notEqual(client.origin, fixture.origin);
    browser = await chromium.launch({ headless: true, executablePath: browserSupply.executable });
    assert.equal(browser.version(), browserSupply.browserVersion);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.pageErrors.push({ message: error.message, stack: error.stack }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('response', response => report.requests.push({ ...requestPath(response.url()), method: response.request().method(), status: response.status() }));
    page.on('requestfailed', request => report.requests.push({ ...requestPath(request.url()), method: request.method(), failure: request.failure()?.errorText }));
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      const observation = { ...requestPath(socket.url()), createdAt: new Date().toISOString(), received: [],
        hasToken: [...url.searchParams].some(([name, value]) => /^(?:api_?key|token)$/iu.test(name) && value.length > 0) };
      report.webSockets.push(observation);
      socket.on('framereceived', event => {
        const text = typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8');
        let type;
        try { type = JSON.parse(text).MessageType; } catch { type = 'unparsed'; }
        observation.received.push({ at: new Date().toISOString(), bytes: Buffer.byteLength(text), type });
      });
      socket.on('socketerror', error => { observation.error = error; });
      socket.on('close', () => { observation.closedAt = new Date().toISOString(); });
    });
    const apiResponse = (pathname, method = 'GET') => page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === fixture.origin && pathname.test(url.pathname) && response.request().method() === method;
    });
    const body = async (response, status = 200) => {
      const text = await response.text();
      assert.equal(typeof response.status === 'function' ? response.status() : response.status, status, text);
      return text ? JSON.parse(text) : null;
    };
    const transition = async (kind, operation) => {
      const interval = { kind, startedAt: new Date().toISOString() };
      report.transitions.push(interval);
      try { return await operation(); }
      finally { interval.finishedAt = new Date().toISOString(); }
    };

    await page.goto(`${client.origin}/index.html`);
    await page.locator('#selectServerPage .btnAddServer').click();
    await page.locator('#txtServerHost').fill(fixture.origin);
    await page.locator('.addServerForm button[type="submit"]').click();
    await page.locator('#loginPage').waitFor({ state: 'visible' });
    await page.locator('#txtManualName').fill(fixture.username);
    await page.locator('#txtManualPassword').fill(fixture.password);
    const [authentication, views] = await Promise.all([
      apiResponse(/\/Users\/AuthenticateByName$/iu, 'POST'),
      apiResponse(/\/(?:UserViews|Users\/[^/]+\/Views)$/iu),
      page.locator('.manualLoginForm button[type="submit"]').click()
    ]);
    const login = await body(authentication);
    report.authenticatedAt = new Date().toISOString();
    fixture.secrets.add(login.AccessToken);
    assert.equal(login.User.Id, fixture.userId);
    report.views = await body(views);
    assert.ok(report.views.Items.some(view => view.Name === fixture.media.libraryName));
    await page.waitForURL(/#\/home(?:[?]|$)/u);
    await page.locator('#indexPage').waitFor({ state: 'visible' });
    report.steps.push('password-login', 'nonempty-user-views');

    const movieId = fixture.media.item.Id;
    await page.locator(`#indexPage a[aria-label="${fixture.media.libraryName}"]`).click();
    const movieCard = page.locator(`.page:not(.hide) .card[data-id="${movieId}"] .cardText a[title="${fixture.media.name}"]`).first();
    await movieCard.waitFor({ state: 'visible' });
    const [detail] = await Promise.all([apiResponse(new RegExp(`/Items/${movieId}$`, 'iu')), movieCard.click()]);
    report.detail = await body(detail);
    assert.equal(report.detail.Name, fixture.media.name);
    assert.match(report.detail.Overview, /Controlled media/u);
    assert.ok(report.detail.ImageTags.Primary);
    const detailPage = page.locator('#itemDetailPage:visible');
    await detailPage.locator('.nameContainer').filter({ hasText: fixture.media.name }).waitFor({ state: 'visible' });
    // A successful image request alone is insufficient: the visible detail image
    // must also have loaded and decoded in the unmodified browser.
    // imageLoader.js sets the CSS background only after its Image load event.
    await page.waitForFunction(() => [...document.querySelectorAll('#itemDetailPage .detailImageContainer .cardImageContainer')]
      .some(image => image.getBoundingClientRect().width > 0 && !image.hasAttribute('data-src')
        && getComputedStyle(image).backgroundImage.startsWith('url(')));
    assert.ok(report.requests.some(request => request.origin === fixture.origin
      && request.path.toLowerCase() === `/items/${movieId}/images/primary`.toLowerCase() && request.status === 200));
    report.steps.push('library-card', 'movie-card', 'movie-details', 'decoded-local-poster');
    await page.screenshot({ path: path.join(output, 'movie.png'), fullPage: true });

    const favoriteButton = detailPage.locator(`.btnUserRating[data-id="${movieId}"]`);
    assert.equal(await favoriteButton.getAttribute('data-isfavorite'), 'false');
    const [favoriteResponse] = await Promise.all([
      apiResponse(new RegExp(`/FavoriteItems/${movieId}$`, 'iu'), 'POST'), favoriteButton.click()
    ]);
    report.favorite = await body(favoriteResponse);
    assert.equal(report.favorite.IsFavorite, true);
    await page.waitForFunction(() => document.querySelector('#itemDetailPage .btnUserRating')?.getAttribute('data-isfavorite') === 'true');
    const playedButton = detailPage.locator(`.btnPlaystate[data-id="${movieId}"]`);
    assert.equal(await playedButton.getAttribute('data-played'), 'false');
    const [playedResponse] = await Promise.all([
      apiResponse(new RegExp(`/PlayedItems/${movieId}$`, 'iu'), 'POST'), playedButton.click()
    ]);
    report.played = await body(playedResponse);
    assert.equal(report.played.Played, true);
    await page.waitForFunction(() => document.querySelector('#itemDetailPage .btnPlaystate')?.getAttribute('data-played') === 'true');
    const saved = await fixture.savedUserData(movieId);
    assert.ok(saved.length > 0);
    assert.ok(saved.every(row => row.IsFavorite === true && row.Played === true && row.PlayCount > 0));
    report.userDataBeforeRestart = saved;
    report.steps.push('favorite-ui-and-postgres', 'watched-ui-and-postgres');

    await detailPage.locator('.btnMoreCommands').click();
    await page.locator('button[data-id="addtoplaylist"]').click();
    await page.locator('#selectPlaylistToAddTo').selectOption('');
    const playlistName = 'Web saved playlist';
    await page.locator('#txtNewPlaylistName').fill(playlistName);
    const [playlistResponse] = await Promise.all([
      apiResponse(/\/Playlists$/iu, 'POST'), page.locator('.dialog .btnSubmit').click()
    ]);
    report.playlist = await body(playlistResponse);
    const playlistId = report.playlist.Id;
    assert.match(playlistId, /^[a-f0-9]{32}$/iu);
    await page.waitForURL(url => url.hash.includes(playlistId));
    await detailPage.locator('.nameContainer').filter({ hasText: playlistName }).waitFor({ state: 'visible' });
    const playlistItem = detailPage.locator(`[data-id="${movieId}"]`).filter({ hasText: fixture.media.name });
    await playlistItem.first().waitFor({ state: 'visible' });
    const members = await fixture.administratorRequest(`/Playlists/${playlistId}/Items?UserId=${fixture.userId}`);
    report.playlistItemsBeforeRestart = await body(members);
    assert.deepEqual(report.playlistItemsBeforeRestart.Items.map(item => item.Id), [movieId]);
    report.steps.push('playlist-created-in-ui', 'playlist-member-visible', 'playlist-server-readback');
    await page.screenshot({ path: path.join(output, 'playlist.png'), fullPage: true });

    await transition('production-restart', () => fixture.restart());
    report.steps.push('production-instance-restarted');
    const cacheSource = 'src/utils/query/queryClient.ts';
    const cachePolicy = await readFile(path.join(web.root, 'source', cacheSource), 'utf8');
    const staleTime = /const MAX_STALENESS = (\d+) \* 1000;/u.exec(cachePolicy);
    assert.ok(staleTime);
    const waitedSince = Date.now();
    await delay(Number(staleTime[1]) * 1000 + 1000);
    report.cacheReadback = { source: cacheSource, declaredMs: Number(staleTime[1]) * 1000, waitedMs: Date.now() - waitedSince };
    const [playlistReadback] = await transition('page-reload', () => Promise.all([
      apiResponse(new RegExp(`/Playlists/${playlistId}/Items$`, 'iu')), page.reload()
    ]));
    report.playlistItemsAfterRestart = await body(playlistReadback);
    assert.deepEqual(report.playlistItemsAfterRestart.Items.map(item => item.Id), [movieId]);
    await detailPage.locator('.nameContainer').filter({ hasText: playlistName }).waitFor({ state: 'visible' });
    await playlistItem.first().waitFor({ state: 'visible' });
    // Browser history returns to the movie that opened the playlist editor.
    const [itemReadback] = await transition('history-back', () => Promise.all([
      apiResponse(new RegExp(`/Items/${movieId}$`, 'iu')), page.goBack()
    ]));
    report.detailAfterRestart = await body(itemReadback);
    assert.equal(report.detailAfterRestart.UserData.IsFavorite, true);
    assert.equal(report.detailAfterRestart.UserData.Played, true);
    await favoriteButton.waitFor({ state: 'visible' });
    assert.equal(await favoriteButton.getAttribute('data-isfavorite'), 'true');
    assert.equal(await playedButton.getAttribute('data-played'), 'true');
    report.userDataAfterRestart = await fixture.savedUserData(movieId);
    assert.deepEqual(report.userDataAfterRestart, report.userDataBeforeRestart);
    report.steps.push('same-browser-session-readback', 'playlist-retained', 'favorite-and-watched-retained');
    const restart = report.transitions.find(interval => interval.kind === 'production-restart');
    assert.ok(report.webSockets.some(socket => socket.hasToken && socket.createdAt >= restart.startedAt
      && socket.received.some(frame => frame.type === 'ForceKeepAlive')),
    'The same client must authenticate a new socket and receive the server handshake after restart.');
    report.steps.push('authenticated-websocket-reconnected');
    await page.screenshot({ path: path.join(output, 'restarted.png'), fullPage: true });
    assert.deepEqual(report.pageErrors, []);
    // The client attempts an anonymous socket before its password login. Its
    // expected 403 must correspond to an observed tokenless pre-login socket;
    // every other server diagnostic remains an assertion failure.
    const anonymousSockets = report.webSockets.filter(socket => socket.path === '/socket' && !socket.hasToken
      && socket.createdAt <= report.authenticatedAt);
    report.expectedAuthenticationRejections = report.preparation.runtimeErrors.filter(error => error.status === 403
      && error.message === 'Token is required' && error.at <= report.authenticatedAt);
    assert.ok(report.expectedAuthenticationRejections.length <= anonymousSockets.length);
    // Reload/back and the intentional server restart can reset an in-flight
    // browser socket. Preserve those diagnostics and bound them to the actual
    // actions; the fresh HTTP/PG/UI and authenticated socket assertions above
    // independently prove recovery. Other transport errors still fail.
    report.expectedTransitionResets = report.preparation.runtimeErrors.filter(error => error.code === 'ECONNRESET'
      && report.transitions.some(interval => Date.parse(error.at) >= Date.parse(interval.startedAt)
        && Date.parse(error.at) <= Date.parse(interval.finishedAt) + 1000));
    assert.deepEqual(report.preparation.runtimeErrors.filter(error => !report.expectedAuthenticationRejections.includes(error)
      && !report.expectedTransitionResets.includes(error)), []);
    assert.deepEqual(client.errors, []);
  } catch (error) {
    failure = error;
    report.failure = { name: error.name, message: error.message, stack: error.stack };
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true,
        mask: [page.locator('input[type="password"]'), page.locator('#txtManualName')] }).catch(error => { report.screenshotError = error.message; });
      await writeFile(path.join(output, 'failure.html'), sanitize(await page.content())).catch(() => {});
    }
  } finally {
    if (client) report.resources = Object.fromEntries(client.resources);
    for (const [name, resource] of [['browser', browser], ['client', client], ['production-instance-and-schema', fixture]]) {
      if (!resource) continue;
      try { await resource.close(); report.cleanup.push({ name, closed: true }); }
      catch (error) { report.cleanup.push({ name, closed: false, error: error.message }); failure ??= error; }
    }
    report.runtimeErrors = fixture?.errors ?? [];
    await writeFile(path.join(output, 'report.json'), sanitize(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2)));
  }
  if (failure) throw new Error(sanitize(failure.message));
});
