const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
function create(ios=false, available=false) {
  const nodes = {}, events = {};
  function element() { return { hidden:false, listeners:{}, children:[], append(...items){this.children.push(...items)}, addEventListener(name,fn){this.listeners[name]=fn} }; }
  for (const id of ['install-pwa','install-status','apk-pending','apk-download','apk-status']) nodes[id]=element();
  nodes['apk-download'].hidden=true;
  const window = { navigator:{}, matchMedia:()=>({matches:false}), addEventListener:(key,fn)=>{(events[key]||=[]).push(fn)} };
  const navigator = { userAgent:ios?'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Safari':'Android', platform:ios?'MacIntel':'Linux', maxTouchPoints:ios?5:1 };
  const document={ createElement:element, body:element(), getElementById:id=>nodes[id] };
  const context=vm.createContext({window, navigator, document, localStorage:{getItem:()=>null,setItem(){}},fetch:async url=>url.endsWith('.apk')?{ok:available,headers:{get:()=> 'application/vnd.android.package-archive'}}:{ok:true,json:async()=>({available,version:'1.0.0',bytes:1048576})}});
  for(const file of ['public/pwa.js','public/shell/install.js'])vm.runInContext(fs.readFileSync(root+'/'+file,'utf8'),context);
  return {window,events,nodes,document};
}
test('PWA prompt, iPad guide, and APK availability states', async () => {
  const android=create(); let prompted=0;
  for(const callback of android.events.beforeinstallprompt)callback({preventDefault(){},prompt(){prompted++},userChoice:Promise.resolve({outcome:'accepted'})});
  await android.nodes['install-pwa'].listeners.click();
  assert.equal(prompted,1,'install page reuses the existing deferred PWA prompt');
  for(const callback of android.events.appinstalled)callback();
  assert.equal(android.nodes['install-pwa'].disabled,true);
  const ios=create(true);
  await ios.nodes['install-pwa'].listeners.click();
  assert.equal(ios.document.body.children[3].hidden,false,'Safari guide shown on iPad');
  await new Promise(r=>setImmediate(r));
  assert.equal(android.nodes['apk-download'].hidden,true,'missing APK is not offered');
  const ready=create(false,true);
  await new Promise(r=>setImmediate(r));
  assert.equal(ready.nodes['apk-download'].hidden,false,'real APK is offered');
});
