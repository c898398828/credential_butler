// UI preview: seeds fictional accounts into the isolated test browser and screenshots each popup screen at 400×580 (2x).
// Start Chrome for Testing with extension/ loaded and --remote-debugging-port, then: node tests/ui-preview.mjs <CDP port>
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect } from './cdp.mjs';

const port = Number(process.argv[2] || 9444);
const out = path.resolve('test-results');
await fs.mkdir(out, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gesture = (expression) => page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });

const page = await connect(port, (t) => t.type === 'page');
await page.send('Page.enable');
await page.send('Page.navigate', { url: 'chrome://extensions/' });
await delay(1500);
const id = await page.evaluate(`new Promise(r => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, list => r(list[0]?.id)))`);
if (!id) throw new Error('Extension not loaded.');
await page.send('Page.navigate', { url: `chrome-extension://${id}/popup.html` });
await delay(1200);

await page.evaluate(`(async () => {
  await chrome.storage.local.clear();
  const S = globalThis.VaultStore;
  await S.saveProfile({ name: '财资云 · 财务部', loginUrl: 'https://toc.icbc.com.cn/login.html#/login', enterpriseId: '10086001', username: 'finance_admin', password: 'Example#2026' }, { makeDefault: true });
  await S.saveProfile({ name: '示例门户', loginUrl: 'https://portal.example.com/login', enterpriseId: '', username: 'alice@example.com', password: 'Example#2026' }, { makeDefault: true });
  await S.saveProfile({ name: '备用账号', loginUrl: 'https://portal.example.com/login', enterpriseId: '', username: 'bob@example.com', password: 'Example#2026' }, { makeDefault: false });
  await S.saveProfile({ name: '内部系统', loginUrl: 'http://intranet.example:8080/login', enterpriseId: 'ORG-42', username: 'carol', password: 'Example#2026' }, { makeDefault: true });
})()`);
await page.send('Page.reload');
await delay(1600);

async function shot(name) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 580, deviceScaleFactor: 2, mobile: false });
  await delay(600);
  const png = await page.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, name), Buffer.from(png.data, 'base64'));
  console.log('saved', name);
}

await shot('ui-home.png');
await gesture(`document.querySelector('.account-card .account-more').click()`);
await delay(400);
await shot('ui-menu.png');
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await gesture(`document.querySelector('#add-button').click()`);
await delay(500);
await shot('ui-editor.png');
await page.evaluate(`const n = document.querySelector('#profile-name'); n.value = '未保存'; n.dispatchEvent(new Event('input', { bubbles: true }));`);
await gesture(`document.querySelector('#back-button').click()`);
await delay(450);
await shot('ui-dialog.png');
await gesture(`document.querySelector('#dialog-confirm').click()`);
await delay(500);
await gesture(`document.querySelector('#tools-button').click()`);
await delay(500);
await shot('ui-tools.png');
await gesture(`document.querySelector('#back-button').click()`);
await delay(400);
await page.evaluate(`const s = document.querySelector('#account-search'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
await delay(350);
await shot('ui-empty.png');
await page.evaluate('chrome.storage.local.clear()');
page.close();
