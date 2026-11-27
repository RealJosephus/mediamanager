import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { browserInputs } from '../../tools/validation/browser-inputs.js';
import { jellyfinWebInputs } from '../../tools/validation/jellyfin-web-inputs.js';
import { createWebServerFixture, serveWebClient } from './web-fixture.js';

export const requiredValidationServices = ['browser','jellyfinWeb','currentNativeSqlite','postgres'];

test('the official Jellyfin Web administrator creates a backup and sees the new archive in the list', {timeout:240000}, async t => {
  const supply=await browserInputs(), web=await jellyfinWebInputs(), fixture=await createWebServerFixture({signal:t.signal});
  let client,browser;
  t.after(async()=>{try{await browser?.close();}finally{try{await client?.close();}finally{await fixture.close();}}});
  const user = await (await fixture.administratorRequest('/Users/' + fixture.userId)).json();
  const policy = await fixture.administratorRequest('/Users/' + fixture.userId + '/Policy', { method:'POST', body:{...user.Policy,IsAdministrator:true} });
  assert.equal(policy.status,204);
  client = await serveWebClient(web.runtime);
  browser = await chromium.launch({headless:true,executablePath:supply.executable});
  const page = await browser.newPage({locale:'en-US',viewport:{width:1280,height:900}});
  page.setDefaultTimeout(40000);
  const responses=[];
  page.on('response', response=>{
    const url=new URL(response.url());
    if(url.origin===fixture.origin && /\/Backup(?:\/|$)/i.test(url.pathname))
      responses.push({path:url.pathname,method:response.request().method(),status:response.status()});
  });
  await page.goto(client.origin + '/index.html');
  await page.locator('#selectServerPage .btnAddServer').click();
  await page.locator('#txtServerHost').fill(fixture.origin);
  await page.locator('.addServerForm button[type="submit"]').click();
  await page.locator('#txtManualName').fill(fixture.username);
  await page.locator('#txtManualPassword').fill(fixture.password);
  const [auth] = await Promise.all([page.waitForResponse(r=>new URL(r.url()).origin===fixture.origin && /\/Users\/AuthenticateByName$/i.test(new URL(r.url()).pathname)),
    page.locator('.manualLoginForm button[type="submit"]').click()]);
  assert.equal(auth.status(),200);
  assert.equal((await auth.json()).User.Policy.IsAdministrator,true);
  await page.waitForURL(/#\/home(?:[?]|$)/u); await page.locator('#indexPage').waitFor({state:'visible'});
  await page.goto(client.origin + '/index.html#/dashboard/backups');
  const create = page.getByRole('button', { name: 'Create Backup', exact: true });
  await create.click({ timeout: 65000 });
  const form = page.getByRole('dialog').filter({ has: page.locator('input[name="Database"]') });
  assert.ok(await form.locator('input[name="Database"]').isChecked());
  await form.locator('input[name="Subtitles"]').check();
  const post = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin &&
    new URL(response.url()).pathname.toLowerCase() === '/backup/create' && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  const warning = page.locator('[role="dialog"],[role="alertdialog"]').filter({
    has: page.getByRole('button', { name: 'Create', exact: true }), hasNot: page.locator('input[name="Database"]')
  });
  if (await Promise.race([post.then(() => false), warning.waitFor({ state: 'visible' }).then(() => true)])) {
    await warning.getByRole('button', { name: 'Create', exact: true }).click();
  }
  const response = await post;
  assert.equal(response.status(), 200, fixture.errors.join('\n'));
  const manifest = await response.json();
  assert.deepEqual(manifest.Options, { Database: true, Metadata: false, Subtitles: true, Trickplay: false });
  await page.getByText(manifest.Path, { exact: true }).waitFor({ state: 'visible' });
  assert.ok(responses.some(r => r.method === 'GET' && r.path.toLowerCase() === '/backup' && r.status === 200));
  t.diagnostic(JSON.stringify({ source: web.receipt.sourceHead, browser: browser.version(),
    page: new URL(page.url()).hash, responses, archive: manifest.Path, options: manifest.Options }));
});
