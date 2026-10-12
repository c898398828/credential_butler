// Live ICBC adapter verification in the dedicated QA profile. No form submissions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';
const port=Number(process.argv[2]);
const popup=await connect(port,t=>t.url.endsWith('/popup.html'));
const bank=await connect(port,t=>t.url.startsWith('https://toc.icbc.com.cn/login.html'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const passed=[];
const requests=[];
const vmExpression=`Array.from(document.querySelectorAll('*')).map(n=>n.__vue__).find(v=>v&&v.loginForm)`;
const vm=()=>bank.evaluate(`(()=>{const vm=${vmExpression};return vm?{company:vm.loginForm.tenantId,user:vm.loginForm.userName,password:vm.loginForm.userPass,code:vm.loginForm.identifyCode}:null})()`);
const check=name=>{passed.push(name);console.log('PASS '+name)};
async function waitModel(profile){
  for(let i=0;i<80;i++){const m=await vm().catch(()=>null);if(m&&m.user===profile.username&&m.password===profile.password&&m.company===profile.enterpriseId)return m;await delay(100)}
  throw new Error('The live login model did not receive the expected fictional profile.');
}
async function switchTabs(){
  for(const name of ['短信登录','账号登录']){
    const clicked=await bank.evaluate(`(()=>{const node=Array.from(document.querySelectorAll('*')).find(e=>e.children.length===0&&e.textContent.trim()===${JSON.stringify(name)});if(!node)return false;node.click();return true})()`);
    assert.equal(clicked,true);await delay(250);
  }
}
try{
  await bank.send('Network.enable');
  bank.on('Network.requestWillBeSent',e=>{if(e.request.method!=='GET')requests.push({method:e.request.method,url:new URL(e.request.url).pathname})});
  const initial=await popup.evaluate('VaultStore.load()');
  // Fail closed if this is not the profile seeded by our preceding isolated QA run.
  const first=initial.profiles.find(p=>p.id==='legacy-default'&&p.username==='demo_finance');
  assert.ok(first,'Expected the isolated, fictional migration fixture.');
  await popup.evaluate('VaultStore.setEnabled(true)');
  await waitModel(first);
  assert.match(await bank.evaluate(`document.querySelector('input[placeholder="请输入登录密码"]').value`),/^\*+$/);
  assert.equal((await vm()).code,'');
  check('migrated v1 default fills the live Vue model and masked password component');

  const second={name:'测试财资云备用',loginUrl:first.loginUrl,enterpriseId:'87654321',username:'demo_audit',password:'QA*密码*Two!52'};
  const existingSecond=initial.profiles.find(p=>p.username===second.username&&p.loginUrl===second.loginUrl);
  if(existingSecond)second.id=existingSecond.id;
  const next=await popup.evaluate(`VaultStore.saveProfile(${JSON.stringify(second)},{makeDefault:false})`);
  const secondSaved=next.profiles.find(p=>p.username===second.username);
  await delay(300);assert.equal((await vm()).password,first.password);
  const tab=await popup.evaluate(`chrome.tabs.query({active:true,currentWindow:true}).then(a=>a[0])`);
  assert.equal(tab.url,first.loginUrl);
  const result=await popup.evaluate(`SiteAccess.fill(${tab.id},${JSON.stringify(secondSaved.id)})`);
  assert.equal(result.ok,true);await waitModel(second);
  assert.equal((await vm()).code,'');
  check('manual account switching replaces the real password, including stars and Unicode');

  await bank.evaluate(`const e=document.querySelector('input[placeholder="请输入用户名"]');e.focus();e.select()`);
  await bank.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await bank.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await bank.evaluate(`document.body.append(document.createElement('hr'))`);
  await delay(250);assert.equal((await vm()).user,'');
  check('a real keyboard edit is preserved on the live site');

  await switchTabs();await waitModel(first);
  check('SMS-to-account mode rebuilds are filled with the configured default');
  await popup.evaluate('VaultStore.setEnabled(false)');
  await switchTabs();
  assert.equal((await vm()).user,'');assert.equal((await vm()).password,'');
  const disabledManual=await popup.evaluate(`SiteAccess.fill(${tab.id},${JSON.stringify(secondSaved.id)})`);
  assert.equal(disabledManual.ok,true);await waitModel(second);
  check('disabled automatic filling leaves a new form empty; explicit filling still works');

  assert.deepEqual(requests,[]);
  check('filling and account-mode changes cause no non-GET requests');
  await popup.evaluate('VaultStore.setEnabled(true)');
  await bank.send('Page.reload');
  await delay(500);await waitModel(first);
  assert.equal((await vm()).code,'');
  // The site itself POSTs its public configuration and encryption-key requests
  // during startup. These are independent of filling and contain no login action.
  assert.ok(requests.every(r=>['/api/portal/login/query-system-setting','/api/fsmc/login/encrypt-key'].includes(r.url)));
  check('page reload fills the saved default; the verification-code field stays empty');

  await fs.writeFile('test-results/v2-icbc-validation.json',JSON.stringify({checks:passed.length,passed,nonGetRequestsDuringFilling:0,siteStartupRequests:requests,submittedLogin:false},null,2));
  console.log(`Completed ${passed.length} live ICBC checks.`);
}finally{popup.close();bank.close()}
