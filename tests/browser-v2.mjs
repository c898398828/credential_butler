// Integration checks against a task-owned Chrome profile. All accounts are fictional.
// Start Chrome with extension/ loaded, then: node tests/browser-v2.mjs <CDP port>
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect } from './cdp.mjs';

const port = Number(process.argv[2]);
if (!port) throw new Error('Provide the isolated Chrome CDP port.');
const out = path.resolve('test-results');
await fs.mkdir(out, { recursive: true });
const passed = [];
const clients = [];
const servers = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (name) => { passed.push(name); console.log(`PASS ${name}`); };

function fixture(kind = 'login') {
  const company = kind === 'company' ? '<label>组织<input name="tenantId"></label>' : '';
  const normal = `${company}<label>账号<input name="username" autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="current-password"></label><label>验证码<input name="otp" autocomplete="one-time-code"></label>`;
  const fields = kind === 'register' ? '<input name="email" type="email"><input name="password" type="password" autocomplete="new-password"><input name="confirmPassword" type="password">'
    : kind === 'custom' ? '<label>编号<input id="x1"></label><label>代码<input id="x2"></label><label>值<input id="x3"></label>' : normal;
  const form = `<form id="login-form">${fields}<button type="submit">登录</button></form>`;
  return `<!doctype html><meta charset="utf-8"><title>Autofill local fixture</title><style>body{font:16px sans-serif;padding:24px}label{display:block;margin:10px 0}input{display:block;width:260px;padding:6px}</style><h1>虚构测试登录页</h1>${kind === 'shadow' ? '<div id="shadow-host"></div>' : form}<script>
    window.submissions=0;
    ${kind === 'shadow' ? `document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(form)};` : ''}
    document.addEventListener('submit',e=>{e.preventDefault();window.submissions++});
    window.rebuild=()=>{const f=document.querySelector('form');f.replaceWith(f.cloneNode(true))};
  </script>`;
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const kind = new URL(req.url, 'http://test').pathname.slice(1).split('/')[0];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fixture(kind));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function client(matches) {
  const c = await connect(port, matches);
  clients.push(c);
  return c;
}

async function waitFor(c, expression, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await c.evaluate(expression); if (last) return last; } catch {}
    await delay(80);
  }
  throw new Error(`Timed out: ${message} (${String(last)})`);
}

async function gesture(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function screenshot(c, name) {
  await c.send('Target.activateTarget', { targetId: c.target.id });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 580, deviceScaleFactor: 1, mobile: false });
  const png = await c.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, name), Buffer.from(png.data, 'base64'));
  if (site) await site.send('Target.activateTarget', { targetId: site.target.id });
}

let popup;
let site;
let tabId;
let originA;
let originB;
const getVault = () => popup.evaluate('VaultStore.load()');
const statusText = () => popup.evaluate('document.querySelector("#app-status").textContent');
async function reloadPopup() {
  await popup.evaluate('globalThis.__qaBeforeReload = true');
  await popup.send('Page.reload');
  await waitFor(popup, 'document.readyState === "complete" && !globalThis.__qaBeforeReload && !!document.querySelector("#add-button") && !document.querySelector("#add-button").disabled', 'popup ready');
}
async function navigate(url) {
  await site.evaluate('globalThis.__qaBeforeNavigate = true');
  await site.send('Page.navigate', { url });
  await waitFor(site, `!globalThis.__qaBeforeNavigate && location.href===${JSON.stringify(url)} && document.readyState==='complete' && document.querySelector("h1")?.textContent === "虚构测试登录页"`, 'fixture load');
  await delay(400);
}
async function fieldValues(c = site) {
  return c.evaluate(`Array.from((document.querySelector('#shadow-host')?.shadowRoot||document).querySelectorAll('input')).map(x=>x.value)`);
}
async function saveUI(data, makeDefault) {
  await gesture(popup, `document.querySelector('#add-button').click()`);
  await popup.evaluate(`(() => {
    const data=${JSON.stringify(data)};
    const mapping={name:'profile-name',loginUrl:'login-url',enterpriseId:'enterprise-id',username:'username',password:'password'};
    for(const [k,id] of Object.entries(mapping)){const e=document.getElementById(id);e.value=data[k]||'';e.dispatchEvent(new Event('input',{bubbles:true}));}
    document.querySelector('#make-default').checked=${makeDefault};
  })()`);
  await gesture(popup, `document.querySelector('#save-button').click()`);
  await waitFor(popup, 'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"', 'save complete');
  assert.equal(await popup.evaluate('document.querySelector("#editor-view").hidden'), true, await statusText());
  return (await getVault()).profiles.find(p => p.username === data.username && p.loginUrl === data.loginUrl);
}
async function openMenu(id) {
  await gesture(popup, `document.querySelector(${JSON.stringify(`[data-profile-id="${id}"] .account-more`)}).click()`);
}
async function menuItem(label) {
  await gesture(popup, `Array.from(document.querySelectorAll('#account-menu button')).find(x=>x.textContent===${JSON.stringify(label)}).click()`);
}

try {
  popup = await client(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/popup.html'));
  await reloadPopup();
  await popup.evaluate(`chrome.scripting.unregisterContentScripts({ids:['qa-port-parse']}).catch(()=>{})`);
  await popup.evaluate('chrome.storage.local.clear()');
  originA = await startServer();
  originB = await startServer();
  // Preauthorize only these ephemeral fixture origins through Chrome's extension
  // management API. Native permission prompts cannot be clicked in headless mode.
  const manager = await client(t => t.url.startsWith('chrome://extensions/'));
  const extensionId = new URL(popup.target.url).hostname;
  for (const origin of [originA, originB]) {
    await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(extensionId)},${JSON.stringify(origin+'/*')})`);
    assert.equal(await gesture(popup, `SiteAccess.requestForUrl(${JSON.stringify(origin)})`), true);
  }
  const tab = await popup.evaluate(`chrome.tabs.create({url:${JSON.stringify(originA + '/login')},active:true})`);
  tabId = tab.id;
  site = await client(t => t.url === originA + '/login');
  await reloadPopup();
  assert.equal(await popup.evaluate('document.querySelectorAll(".account-card").length'), 0);
  record('empty vault and current-site context');

  const a = {name:'测试 OA · 默认',loginUrl:originA+'/login',enterpriseId:'',username:'qa_alice',password:'Demo*One!42'};
  const a1 = await saveUI(a, true);
  assert.ok(a1?.id);
  await waitFor(site, `document.querySelector('[name=password]').value===${JSON.stringify(a.password)}`, 'newly authorized autofill');
  assert.deepEqual(await fieldValues(), [a.username,a.password,'']);
  record('UI save, actual per-site permission, current page autofill, OTP untouched');

  const b = {name:'测试 OA · 备用',loginUrl:originA+'/login',enterpriseId:'',username:'qa_bob',password:'Second*测试!53'};
  const a2 = await saveUI(b, false);
  assert.equal((await getVault()).defaultProfiles[originA],a1.id);
  assert.deepEqual(await fieldValues(),[a.username,a.password,'']);
  await gesture(popup,'document.querySelector("#fill-button").click()');
  await waitFor(popup,'!document.querySelector("#fill-button").disabled','manual fill complete');
  assert.deepEqual(await fieldValues(),[b.username,b.password,'']);
  assert.equal((await getVault()).defaultProfiles[originA],a1.id);
  record('manual account switching preserves site default and literal password');

  await navigate(originA+'/login');
  assert.deepEqual(await fieldValues(),[a.username,a.password,'']);
  record('dynamic script runs automatically after navigation');
  await site.evaluate(`document.querySelector('[name=username]').focus();document.querySelector('[name=username]').select()`);
  await site.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await site.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await site.evaluate(`document.body.append(document.createElement('hr'))`);
  await delay(250);
  assert.equal((await fieldValues())[0],'');
  record('trusted user editing is not overwritten');

  await navigate(originA+'/other');
  assert.deepEqual(await fieldValues(),['','','']);
  await navigate(originB+'/login');
  assert.deepEqual(await fieldValues(),['','','']);
  record('different path and same host on a different port remain empty');

  const c = {name:'测试管理 · 默认',loginUrl:originB+'/company',enterpriseId:'ACME',username:'qa_ops',password:'Ops*Example!76'};
  await navigate(c.loginUrl);
  await reloadPopup();
  const b1 = await saveUI(c,true);
  await waitFor(site, `document.querySelector('[name=password]').value===${JSON.stringify(c.password)}`, 'company autofill');
  assert.deepEqual(await fieldValues(),[c.enterpriseId,c.username,c.password,'']);
  record('second site has an independent company/account/password default');

  await gesture(popup, 'document.querySelector("#filter-all").click()');
  assert.equal(await popup.evaluate('document.querySelectorAll(".account-card").length'),3);
  await popup.evaluate(`document.querySelector('#account-search').value='qa_bob';document.querySelector('#account-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await popup.evaluate('document.querySelectorAll(".account-card").length'),1);
  await popup.evaluate(`document.querySelector('#account-search').value='absent-account';document.querySelector('#account-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await popup.evaluate('document.querySelector("#fill-button").disabled'),true);
  await popup.evaluate(`document.querySelector('#account-search').value='';document.querySelector('#account-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  record('all/current filters, search, and no hidden fill target');

  await popup.evaluate(`globalThis.__copied=[];Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{globalThis.__copied.push(text)}})`);
  await openMenu(b1.id);
  await screenshot(popup,'v2-menu.png');
  await menuItem('复制账号');
  assert.deepEqual(await popup.evaluate('globalThis.__copied'),[c.username]);
  record('copy action dispatches selected field without touching system clipboard');

  await openMenu(b1.id);await menuItem('编辑账号');
  assert.equal(await popup.evaluate('document.querySelector("#password").type'),'password');
  await gesture(popup,'document.querySelector("#toggle-password").click()');
  assert.equal(await popup.evaluate('document.querySelector("#password").type'),'text');
  await gesture(popup,'document.querySelector("#toggle-password").click()');
  await screenshot(popup,'v2-editor.png');
  await popup.evaluate(`document.querySelector('#profile-name').value='未保存测试修改';document.querySelector('#profile-name').dispatchEvent(new Event('input',{bubbles:true}))`);
  await gesture(popup,'document.querySelector("#back-button").click()');
  assert.equal(await popup.evaluate('document.querySelector("#confirmation-dialog").open'),true);
  await screenshot(popup,'v2-dialog.png');
  await gesture(popup,'document.querySelector("#dialog-cancel").click()');
  assert.equal(await popup.evaluate('document.querySelector("#editor-view").hidden'),false);
  await gesture(popup,'document.querySelector("#back-button").click()');
  await gesture(popup,'document.querySelector("#dialog-confirm").click()');
  record('masked editor, reveal toggle, and cancel/discard changes dialog');

  await openMenu(a2.id);await menuItem('设为网站默认');
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','set default');
  assert.equal((await getVault()).defaultProfiles[originA],a2.id);
  assert.equal((await getVault()).defaultProfiles[originB],b1.id);
  await openMenu(a2.id);await menuItem('删除账号');
  await gesture(popup,'document.querySelector("#dialog-cancel").click()');
  assert.equal((await getVault()).profiles.length,3);
  await openMenu(a2.id);await menuItem('删除账号');
  await gesture(popup,'document.querySelector("#dialog-confirm").click()');
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','delete account');
  assert.equal((await getVault()).profiles.length,2);
  assert.equal((await getVault()).defaultProfiles[originA],'');
  await navigate(originA+'/login');
  assert.deepEqual(await fieldValues(),['','','']);
  record('default changes are per site; deleting a default never chooses another identity');

  await reloadPopup();
  await gesture(popup,'document.querySelector("#tools-button").click()');
  await gesture(popup,'document.querySelector("#generate-button").click()');
  const generated = await popup.evaluate('document.querySelector("#generated-password").value');
  assert.equal(generated.length,20);
  assert.match(generated,/[a-z]/);assert.match(generated,/[A-Z]/);assert.match(generated,/\d/);assert.match(generated,/[^a-zA-Z0-9]/);
  await screenshot(popup,'v2-tools.png');
  record('password generator produces the chosen length and character classes');

  const downloads = path.join(out,'downloads');
  await fs.mkdir(downloads,{recursive:true});
  await popup.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await popup.evaluate(`document.querySelector('#backup-section').open=true;document.querySelector('#backup-passphrase').value='Demo backup passphrase 2026'`);
  await gesture(popup,'document.querySelector("#export-backup").click()');
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','export backup');
  let backupPath;
  for(let i=0;i<40;i++){const names=await fs.readdir(downloads);const name=names.find(n=>n.endsWith('.json'));if(name){backupPath=path.join(downloads,name);break;}await delay(100);}
  assert.ok(backupPath,'download exists');
  const backup=await fs.readFile(backupPath,'utf8');
  assert.equal(backup.includes(c.password),false);assert.equal(backup.includes(c.username),false);
  assert.equal(JSON.parse(backup).cipher,'AES-GCM');
  record('UI export downloads a password-encrypted file without plaintext credentials');

  await popup.evaluate(`document.querySelector('#clear-section').open=true`);
  await gesture(popup,'document.querySelector("#clear-button").click()');
  await gesture(popup,'document.querySelector("#cancel-clear").click()');
  assert.equal((await getVault()).profiles.length,2);
  await gesture(popup,'document.querySelector("#clear-button").click()');
  await gesture(popup,'document.querySelector("#confirm-clear").click()');
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','clear data');
  assert.equal((await getVault()).profiles.length,0);assert.equal((await getVault()).enabled,false);
  await popup.send('DOM.enable');
  const {root}=await popup.send('DOM.getDocument');
  const {nodeId}=await popup.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#backup-file'});
  await popup.evaluate(`document.querySelector('#backup-passphrase').value='Wrong backup passphrase'`);
  await popup.send('DOM.setFileInputFiles',{nodeId,files:[backupPath]});
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','wrong backup password');
  assert.match(await statusText(),/导入失败/);assert.equal((await getVault()).profiles.length,0);
  await popup.evaluate(`document.querySelector('#backup-passphrase').value='Demo backup passphrase 2026'`);
  await popup.send('DOM.setFileInputFiles',{nodeId,files:[backupPath]});
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','import backup');
  assert.equal((await getVault()).profiles.length,2);
  await popup.evaluate(`document.querySelector('#backup-passphrase').value='Demo backup passphrase 2026'`);
  await popup.send('DOM.setFileInputFiles',{nodeId,files:[backupPath]});
  await waitFor(popup,'document.querySelector("#app-shell").getAttribute("aria-busy")==="false"','duplicate import');
  assert.equal((await getVault()).profiles.length,2);assert.match(await statusText(),/跳过 2/);
  record('clear confirmation, wrong-password rejection, restore, and duplicate merge');

  const saved = await getVault();
  const aNow=saved.profiles.find(p=>p.username===a.username);
  async function configureGeneric(kind,selectors={},company=''){
    await popup.evaluate(`VaultStore.saveProfile(${JSON.stringify({...aNow,loginUrl:originA+'/'+kind,enterpriseId:company,selectors})},{makeDefault:true})`);
    await popup.evaluate('VaultStore.setEnabled(true)');await popup.evaluate('SiteAccess.sync()');
    await navigate(originA+'/'+kind);
  }
  await configureGeneric('shadow');
  assert.deepEqual(await fieldValues(),[a.username,a.password,'']);
  record('visible fields inside an open shadow root are filled');
  await configureGeneric('custom',{enterpriseId:'#x1',username:'#x2',password:'#x3'},'LAB');
  assert.deepEqual(await fieldValues(),['LAB',a.username,a.password]);
  record('custom selectors fill an otherwise unrecognized form');
  await configureGeneric('register');
  assert.deepEqual(await fieldValues(),['','','']);
  record('registration and new-password fields remain empty');
  await configureGeneric('login');
  await popup.evaluate('VaultStore.setEnabled(false)');
  await navigate(originA+'/login');
  assert.deepEqual(await fieldValues(),['','','']);
  const manual=await popup.evaluate(`SiteAccess.fill(${tabId},${JSON.stringify(aNow.id)})`);
  assert.equal(manual.ok,true);assert.deepEqual(await fieldValues(),[a.username,a.password,'']);
  assert.equal(await site.evaluate('window.submissions'),0);
  record('disabled autofill still permits manual fill; login is never submitted');

  await popup.evaluate(`chrome.storage.local.clear()`);
  await popup.evaluate(`chrome.storage.local.set({defaultProfile:{enterpriseId:'12345678',username:'demo_finance',password:'Demo*ICBC!测试42',enabled:false}})`);
  await reloadPopup();
  const migrated=await getVault();
  assert.equal(migrated.profiles[0].id,'legacy-default');assert.equal(migrated.enabled,false);
  assert.equal(await popup.evaluate(`chrome.storage.local.get('defaultProfile').then(v=>Object.hasOwn(v,'defaultProfile'))`),false);
  record('v1 credentials migrate without losing the password or enabled preference');

  await fs.writeFile(path.join(out,'v2-browser-validation.json'),JSON.stringify({checks:passed.length,passed,fixtureOnly:true},null,2));
  console.log(`Completed ${passed.length} browser checks. Isolated Chrome remains available for live ICBC QA.`);
} catch(error) {
  if(popup) await screenshot(popup,'v2-failure.png').catch(()=>{});
  await fs.writeFile(path.join(out,'v2-browser-validation.json'),JSON.stringify({checks:passed.length,passed,failure:error.message},null,2));
  throw error;
} finally {
  for(const c of clients)c.close();
  for(const server of servers) await new Promise(resolve=>server.close(resolve));
}
