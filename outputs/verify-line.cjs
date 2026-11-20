const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {context:c,call,keys,props,sheets}=require('./verify-family.cjs');
c.Utilities.base64EncodeWebSafe=bytes=>Buffer.from(bytes.map(x=>(x+256)%256)).toString('base64url');
Object.assign(props,{LINE_NOTIFY_ENABLED:'true',LINE_CHANNEL_ACCESS_TOKEN:'TEST_ONLY_LINE_TOKEN',LINE_LOGIN_CHANNEL_ID:'1234567890',LINE_LOGIN_CHANNEL_SECRET:'TEST_ONLY_LOGIN_SECRET',LINE_CALLBACK_URL:'https://script.google.com/macros/s/TEST_ONLY/exec'});
let subject='U'+'1'.repeat(32),friend=true,badNonce=false,pushStatus=503,pushes=[],exchanges=[];
c.UrlFetchApp={fetch(url,options={}){
 const response=(status,body)=>({getResponseCode:()=>status,getContentText:()=>JSON.stringify(body)});
 if(url.endsWith('/token')){exchanges.push(options);return response(200,{id_token:'TEST_ID_TOKEN',access_token:'TEST_USER_TOKEN'});}
 if(url.endsWith('/verify'))return response(200,{iss:'https://access.line.me',aud:props.LINE_LOGIN_CHANNEL_ID,nonce:badNonce?'wrong':options.payload.nonce,exp:Math.floor(Date.now()/1000)+600,sub:subject});
 if(url.endsWith('/status'))return response(200,{friendFlag:friend});
 if(url.endsWith('/push')){pushes.push(options);return response(pushStatus,{});}
 throw Error('Unexpected endpoint: '+url);
}};
function begin(token){const r=call(token,{action:'line.begin'});assert.equal(r.ok,true);const url=new URL(r.url),state=url.searchParams.get('state');assert.equal(url.origin,'https://access.line.me');assert.equal(url.searchParams.get('scope'),'openid profile');assert.ok(!r.url.includes(keys.admin));return {url,state,pending:JSON.parse(props['LINE_OAUTH_'+state])};}
function callback(b){return c.lineCallback_({state:b.state,code:'TEST_AUTH_CODE'}).html;}
const admin=call(keys.admin,{action:'pull'}).member,dad=call(keys.dad,{action:'pull'}).member;
assert.equal(call(keys.child,{action:'line.begin'}).error.code,'FORBIDDEN');
assert.equal(call(keys.admin,{action:'line.status'}).line.connected,false);
const first=begin(keys.admin);
assert.equal(first.url.searchParams.get('code_challenge'),crypto.createHash('sha256').update(first.pending.verifier).digest('base64url'));
badNonce=true;assert.ok(callback(first).includes('未完成'));assert.equal(props['LINE_PARENT_'+admin.id],undefined);badNonce=false;
assert.ok(callback(first).includes('未完成')); // State is one-time, even on failure.
const noFriend=begin(keys.admin);friend=false;assert.ok(callback(noFriend).includes('先將'));friend=true;assert.equal(props['LINE_PARENT_'+admin.id],undefined);
const expired=begin(keys.admin);const old=JSON.parse(props['LINE_OAUTH_'+expired.state]);old.expires=0;props['LINE_OAUTH_'+expired.state]=JSON.stringify(old);assert.ok(callback(expired).includes('未完成'));
assert.ok(callback(begin(keys.admin)).includes('連接成功'));assert.equal(call(keys.admin,{action:'line.status'}).line.connected,true);
assert.equal(exchanges.at(-1).payload.code_verifier.length,64);assert.ok(!JSON.stringify(call(keys.admin,{action:'line.status'})).includes(subject));
const apply=id=>call(keys.child,{action:'apply',operation:crypto.randomUUID(),changes:[{kind:'diary',id,baseVersion:0,deleted:false,value:{date:'2026-11-20',text:'絕對不要出現在 LINE 通知中的日記全文',mood:'😊',sticker:'🌷'}}]});
assert.equal(apply('line-diary-1').ok,true);c.lineDrain_();assert.equal(pushes.length,1);assert.equal(sheets.get('LINE通知').data[1][6],'待發送');
assert.ok(!pushes[0].payload.includes('日記全文'));assert.ok(!pushes[0].payload.includes(keys.admin));assert.ok(JSON.parse(pushes[0].payload).messages[0].text.includes('女兒'));
const retryKey=pushes[0].headers['X-Line-Retry-Key'];pushStatus=200;c.lineDrain_();assert.equal(pushes[1].headers['X-Line-Retry-Key'],retryKey);assert.equal(sheets.get('LINE通知').data[1][6],'LINE已接受');c.lineDrain_();assert.equal(pushes.length,2);
// A second family member cannot bind the first parent's LINE.
assert.ok(callback(begin(keys.dad)).includes('另一位家長'));assert.equal(props['LINE_PARENT_'+dad.id],undefined);
subject='U'+'2'.repeat(32);assert.ok(callback(begin(keys.dad)).includes('連接成功'));
const extra='E'.repeat(43);call(keys.admin,{action:'member.add',name:'其他家長',role:'parent',newToken:extra});assert.equal(call(extra,{action:'line.begin'}).error.code,'LINE_LIMIT');
assert.equal(apply('line-diary-2').ok,true);pushStatus=503;c.lineDrain_();const queue=sheets.get('LINE通知');assert.equal(queue.data.length,4);assert.equal(queue.data[2][6],'待發送');assert.equal(queue.data[3][6],'待發送');
call(keys.dad,{action:'line.disconnect'});pushStatus=409;c.lineDrain_();assert.equal(queue.data[2][6],'LINE已接受');assert.equal(queue.data[3][6],'已取消');
const before=pushes.length;assert.equal(apply('line-diary-2').error.code,'CONFLICT');c.lineDrain_();assert.equal(pushes.length,before);
// Opting back in starts with future updates, never backfills earlier private entries.
props.LINE_NOTIFY_CURSOR='0';subject='U'+'2'.repeat(32);assert.ok(callback(begin(keys.dad)).includes('連接成功'));c.lineDrain_();assert.equal(queue.data.length,4);
assert.equal(apply('line-diary-3').ok,true);pushStatus=503;c.lineDrain_();const last=queue.data.length-1;queue.data[last][7]=new Date(Date.now()-24*3600000).toISOString();c.lineDrain_();assert.equal(queue.data[last][6],'已逾期');
props.LINE_NOTIFY_ENABLED='false';const count=pushes.length;c.lineDrain_();assert.equal(pushes.length,count);assert.equal(call(keys.admin,{action:'line.status'}).line.configured,false);
console.log('PASS: parent-only OAuth with PKCE/state/nonce, one-time callbacks, verified IDs/friendship, two-parent cap, no private diary content or family credentials in messages, durable queue, retries keep the same key, accepted retries do not duplicate, stopped members skipped, old records excluded, expired jobs stopped, disabled mode sends nothing. No real LINE or Google requests.');
