/** LINE 通知：只向親自綁定的兩位家長發送；權杖只存指令碼屬性。 */
var LINE_QUEUE_HEADERS=['通知ID','操作ID','收件成員','LINE收件ID','重試ID','通知內容','狀態','建立時間','最後嘗試','HTTP狀態'];
function lineConfig_(){
  var p=PropertiesService.getScriptProperties();
  return {enabled:p.getProperty('LINE_NOTIFY_ENABLED')==='true',token:p.getProperty('LINE_CHANNEL_ACCESS_TOKEN')||'',clientId:p.getProperty('LINE_LOGIN_CHANNEL_ID')||'',secret:p.getProperty('LINE_LOGIN_CHANNEL_SECRET')||'',callback:p.getProperty('LINE_CALLBACK_URL')||''};
}
function lineReady_(c){return c.enabled&&c.token&&/^\d+$/.test(c.clientId)&&c.secret&&/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(c.callback);}
function lineBinding_(id){var raw=PropertiesService.getScriptProperties().getProperty('LINE_PARENT_'+id);return raw?JSON.parse(raw):null;}
function lineRandom_(){return (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');}
function lineAction_(request,member,members,replay){
  if(member.role!=='admin'&&member.role!=='parent')throw familyError_('FORBIDDEN','LINE 通知僅提供家長綁定。');
  var p=PropertiesService.getScriptProperties(),c=lineConfig_(),binding=lineBinding_(member.id);
  if(request.action==='line.status')return {ok:true,line:{configured:!!lineReady_(c),connected:!!binding,accountName:'Ann\'s family',lastError:p.getProperty('LINE_LAST_ERROR')||''}};
  if(request.action==='line.disconnect'){p.deleteProperty('LINE_PARENT_'+member.id);return {ok:true};}
  if(request.action!=='line.begin')throw familyError_('ACTION','不支援的 LINE 通知操作。');
  if(!lineReady_(c))throw familyError_('LINE_CONFIG','家庭管理者尚未完成 LINE 通知設定。');
  var active=members.filter(function(m){return m.active&&m.role!=='child'&&lineBinding_(m.id);});
  if(!binding&&active.length>=2)throw familyError_('LINE_LIMIT','目前已綁定兩位家長；請先解除不再使用的連線。');
  var previous=p.getProperty('LINE_PENDING_'+member.id);if(previous)p.deleteProperty('LINE_OAUTH_'+previous);
  var state=lineRandom_(),nonce=lineRandom_(),verifier=lineRandom_();
  p.setProperty('LINE_OAUTH_'+state,JSON.stringify({memberId:member.id,nonce:nonce,verifier:verifier,expires:Date.now()+600000}));
  p.setProperty('LINE_PENDING_'+member.id,state);
  var challenge=Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,verifier,Utilities.Charset.UTF_8)).replace(/=+$/,'');
  var fields={response_type:'code',client_id:c.clientId,redirect_uri:c.callback,state:state,scope:'openid profile',nonce:nonce,bot_prompt:'normal',code_challenge:challenge,code_challenge_method:'S256'};
  return {ok:true,url:'https://access.line.me/oauth2/v2.1/authorize?'+Object.keys(fields).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(fields[k]);}).join('&')};
}
function lineHTTP_(url,options){
  options=options||{};options.muteHttpExceptions=true;options.followRedirects=false;
  var response=UrlFetchApp.fetch(url,options),status=response.getResponseCode();
  if(status!==200)throw familyError_('LINE_REMOTE','LINE 連接未完成，請回手帳重新連接。');
  return JSON.parse(response.getContentText());
}
function lineCallback_(q){
  var message='LINE 通知綁定未完成，請回手帳重新連接。',lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    var p=PropertiesService.getScriptProperties(),c=lineConfig_(),state=String(q.state||'');
    if(!/^[a-f0-9]{64}$/i.test(state)||!lineReady_(c))throw Error('invalid');
    var raw=p.getProperty('LINE_OAUTH_'+state);if(!raw)throw Error('expired');
    var pending=JSON.parse(raw);p.deleteProperty('LINE_OAUTH_'+state);p.deleteProperty('LINE_PENDING_'+pending.memberId);
    if(pending.expires<Date.now()||q.error||!q.code)throw Error('expired');
    var book=SpreadsheetApp.openById(FAMILY_SHEET_ID),members=rows_(ensureSheet_(book,'家庭成員'));
    var me=members.filter(function(r){return r[0]===pending.memberId&&(r[4]===true||r[4]==='TRUE')&&(r[2]==='admin'||r[2]==='parent');})[0];if(!me)throw Error('member');
    var tokens=lineHTTP_('https://api.line.me/oauth2/v2.1/token',{method:'post',payload:{grant_type:'authorization_code',code:q.code,redirect_uri:c.callback,client_id:c.clientId,client_secret:c.secret,code_verifier:pending.verifier}});
    var identity=lineHTTP_('https://api.line.me/oauth2/v2.1/verify',{method:'post',payload:{id_token:tokens.id_token,client_id:c.clientId,nonce:pending.nonce}});
    if(identity.iss!=='https://access.line.me'||String(identity.aud)!==c.clientId||identity.nonce!==pending.nonce||Number(identity.exp)*1000<=Date.now()||!/^U[a-f0-9]{32}$/i.test(identity.sub||''))throw Error('identity');
    var friend=lineHTTP_('https://api.line.me/friendship/v1/status',{headers:{Authorization:'Bearer '+tokens.access_token}});
    if(friend.friendFlag!==true){message='請先將 Ann\'s family 加入好友，再回手帳重新連接 LINE 通知。';throw Error('friend');}
    var active=members.filter(function(r){return (r[4]===true||r[4]==='TRUE')&&(r[2]==='admin'||r[2]==='parent')&&lineBinding_(r[0]);});
    if(!lineBinding_(pending.memberId)&&active.length>=2)throw Error('limit');
    if(active.some(function(r){var b=lineBinding_(r[0]);return r[0]!==pending.memberId&&b.userId===identity.sub;})){message='這個 LINE 已綁定另一位家長，請使用你自己的 LINE 帳號。';throw Error('duplicate');}
    var revision=replay_(rows_(ensureSheet_(book,'同步紀錄'))).revision;
    p.setProperty('LINE_PARENT_'+pending.memberId,JSON.stringify({userId:identity.sub,afterRevision:revision,created:Date.now()}));
    message='LINE 通知已連接成功。之後家人同步新的手帳紀錄，會由 Ann\'s family 傳送通知給你。';
  }catch(error){/* Never echo authorization codes, tokens, or provider error bodies. */}
  finally{lock.releaseLock();}
  return HtmlService.createHtmlOutput('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>小日子 LINE 通知</title><style>body{font:18px/1.8 sans-serif;max-width:430px;margin:12vh auto;padding:24px;background:#f6f4ef;color:#514b43}a{display:block;background:#765171;color:white;padding:12px;text-align:center;border-radius:14px}</style><h1>🏡 小日子</h1><p>'+message+'</p><a target="_top" href="https://wendy730214-pixel.github.io/Ann-s-diary/">回到家庭手帳</a></html>');
}
function lineQueueSheet_(book){
  var s=book.getSheetByName('LINE通知');if(!s)s=book.insertSheet('LINE通知');
  if(!s.getLastRow()){s.getRange(1,1,1,LINE_QUEUE_HEADERS.length).setValues([LINE_QUEUE_HEADERS]).setBackground('#5f7653').setFontColor('#ffffff').setFontWeight('bold');s.setFrozenRows(1);s.setColumnWidths(1,LINE_QUEUE_HEADERS.length,140);}
  if(JSON.stringify(s.getRange(1,1,1,LINE_QUEUE_HEADERS.length).getValues()[0])!==JSON.stringify(LINE_QUEUE_HEADERS))throw Error('LINE queue header mismatch');
  return s;
}
function lineNoticeText_(name,changes){
  var counts={},labels={diary:'日記',reply:'日記回覆',event:'共同約定',transaction:'撲滿收支',goal:'存錢願望'};
  changes.forEach(function(r){var label=labels[r.kind];if(label)counts[label]=(counts[label]||0)+1;});
  return '🏡 小日子家庭手帳\n'+name+' 更新了 '+Object.keys(counts).map(function(k){return counts[k]+' 筆'+k;}).join('、')+'。\n打開手帳看看吧：\nhttps://wendy730214-pixel.github.io/Ann-s-diary/';
}
// Called after a successful API response and also by the owner's retry trigger.
function deliverLineNotifications(){lineDrain_();}
function lineDrain_(){
  var c=lineConfig_();if(!lineReady_(c))return;
  var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try{
    var p=PropertiesService.getScriptProperties(),book=SpreadsheetApp.openById(FAMILY_SHEET_ID),log=rows_(ensureSheet_(book,'同步紀錄'));
    var members=rows_(ensureSheet_(book,'家庭成員')).filter(function(r){return (r[4]===true||r[4]==='TRUE')&&(r[2]==='admin'||r[2]==='parent');});
    var sheet=lineQueueSheet_(book),jobs=rows_(sheet),known={};jobs.forEach(function(r){known[r[0]]=true;});
    var cursor=Number(p.getProperty('LINE_NOTIFY_CURSOR')||0);
    log.filter(function(r){return Number(r[1])>cursor;}).slice(0,30).forEach(function(r){
      var text=lineNoticeText_(r[3],JSON.parse(r[5]));
      members.forEach(function(m){var binding=lineBinding_(m[0]),id=r[0]+':'+m[0];if(binding&&Number(r[1])>binding.afterRevision&&!known[id]){var job=[id,r[0],m[0],binding.userId,Utilities.getUuid(),text,'待發送',new Date().toISOString(),'',''];sheet.appendRow(job);jobs.push(job);known[id]=true;}});
      cursor=Number(r[1]);p.setProperty('LINE_NOTIFY_CURSOR',String(cursor));
    });
    var attempts=0,deadline=Date.now()+20000,error='';
    jobs.forEach(function(job,index){
      if(job[6]!=='待發送'||attempts>=4||Date.now()>deadline)return;
      var binding=lineBinding_(job[2]),active=members.some(function(m){return m[0]===job[2];});
      if(!active||!binding||binding.userId!==job[3]){sheet.getRange(index+2,7).setValue('已取消');return;}
      if(Date.now()-Date.parse(job[7])>23*3600000){sheet.getRange(index+2,7).setValue('已逾期');error='有通知逾期未送出，請檢查 LINE 額度或連線設定。';return;}
      attempts++;var status=0;
      try{var response=UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+c.token,'X-Line-Retry-Key':job[4]},payload:JSON.stringify({to:job[3],messages:[{type:'text',text:job[5]}]}),muteHttpExceptions:true,followRedirects:false});status=response.getResponseCode();if(status===200||status===409)sheet.getRange(index+2,7).setValue('LINE已接受');else error=status===429?'LINE 額度或速率限制，通知保留待重試。':'LINE 通知尚未送出，請檢查官方帳號的設定。';}catch(e){error='LINE 通知連線失敗，保留待重試。';}
      sheet.getRange(index+2,9,1,2).setValues([[new Date().toISOString(),status]]);
    });
    p.setProperty('LINE_LAST_ERROR',error);SpreadsheetApp.flush();
  }finally{lock.releaseLock();}
}
// Owner runs this once after setting the five LINE properties and confirming recipients opt in.
function prepareLineDelivery(){
  if(!lineReady_(lineConfig_()))throw Error('請先完成 LINE 指令碼屬性設定。');
  lineQueueSheet_(SpreadsheetApp.openById(FAMILY_SHEET_ID));
  var triggers=ScriptApp.getProjectTriggers();if(!triggers.some(function(t){return t.getHandlerFunction()==='deliverLineNotifications';}))ScriptApp.newTrigger('deliverLineNotifications').timeBased().everyMinutes(5).create();
  return '通知重試服務已準備好；家長仍需在手帳內各自綁定自己的 LINE。';
}
