const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const manifest=JSON.parse(fs.readFileSync('manifest.webmanifest','utf8'));
assert.equal(manifest.scope,'./');assert.equal(manifest.start_url,'./');assert.equal(manifest.id,'./');assert.equal(manifest.display,'standalone');
for(const i of manifest.icons){const b=fs.readFileSync(i.src);assert.equal(b.readUInt32BE(16),Number(i.sizes.split('x')[0]));assert.equal(b.readUInt32BE(20),Number(i.sizes.split('x')[1]));}
for(const file of ['index.html','family-journal.html']){const h=fs.readFileSync(file,'utf8');assert.ok(h.includes('href="./manifest.webmanifest"'));assert.ok(h.includes("const KEY='little-days-family-v1'"));assert.ok(h.includes('src="./pwa.js"'));new vm.Script(h.match(/<script>([\s\S]*?)<\/script>/)[1]);}
new vm.Script(fs.readFileSync('pwa.js','utf8'));
const scope='https://example.test/Ann-s-diary/',handlers={},stores=new Map();let offline=false,server404=false;
async function fetchMock(request){if(offline)throw Error('offline');const url=typeof request==='string'?request:request.url;const filename=new URL(url).pathname.replace('/Ann-s-diary/','')||'index.html';if(server404)return new Response('not found',{status:404});return new Response(fs.readFileSync(filename),{headers:{'Content-Type':filename.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'}});}
const caches={
 keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),
 open:async name=>{
  if(!stores.has(name))stores.set(name,new Map());
  const m=stores.get(name),key=r=>typeof r==='string'?r:r.url;
  return {
   match:async r=>m.get(key(r))?.clone(),put:async(r,v)=>m.set(key(r),v),
   addAll:async reqs=>{const all=await Promise.all(reqs.map(async r=>{const v=await fetchMock(r);if(!v.ok)throw Error('bad asset');return[r.url,v]}));all.forEach(([k,v])=>m.set(k,v));}
  };
 }
};
const ctx=vm.createContext({self:{registration:{scope},location:{origin:'https://example.test'},clients:{claim:async()=>{}},addEventListener:(n,f)=>handlers[n]=f},URL,Request,Response,AbortController,setTimeout,clearTimeout,caches,fetch:fetchMock,Set,Promise});
vm.runInContext(fs.readFileSync('sw.js','utf8'),ctx);
async function lifecycle(name){let p;handlers[name]({waitUntil:v=>p=v});await p;}
async function get(path,mode='navigate',method='GET'){let p;handlers.fetch({request:{url:new URL(path,scope).href,mode,method},respondWith:v=>p=v});return p;}
(async()=>{await lifecycle('install');const cacheName=[...stores.keys()][0];assert.equal(stores.get(cacheName).size,13);stores.set('another-app-cache',new Map());stores.set('ann-diary-pwa:'+scope+':old',new Map());await lifecycle('activate');assert.ok(stores.has('another-app-cache'));assert.ok(!stores.has('ann-diary-pwa:'+scope+':old'));
offline=true;for(const url of ['./','index.html','family-journal.html','./?from=home']){const res=await get(url);assert.equal(res.status,200);assert.ok((await res.text()).includes('pwa-install'));}const icon=await get('icon-192.png','no-cors');assert.ok((await icon.arrayBuffer()).byteLength>1000);assert.equal(await get('https://another.test/api'),undefined);assert.equal(await get('./','navigate','POST'),undefined);offline=false;server404=true;assert.equal((await get('./')).status,200);server404=false;assert.equal((await get('./')).status,200);
console.log('PASS: manifest subpath/scope/ID, PNG sizes, preserved localStorage key, JS syntax, all 13 precache assets including family sync code, offline navigation and icons, 404 fallback, safe cache cleanup, external/POST requests untouched.');})().catch(e=>{console.error(e);process.exitCode=1});
