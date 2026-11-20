/** 小日子家庭共用後端。僅使用指定試算表；連線碼只保存 SHA-256。 */
var FAMILY_SHEET_ID = '1pWdCgSIRRpiNBjnTh2nMHVt_DaBMahwIg2NoCw5p-vU';
var FAMILY_ORIGIN = 'https://wendy730214-pixel.github.io';
var FAMILY_SCHEMA = {
  '家庭成員': ['成員ID','名字','角色','連線碼雜湊','啟用','建立時間'],
  '同步紀錄': ['操作ID','版本','成員ID','名字','時間','變更JSON'],
  '家庭日記': ['日記ID','日期','作者','心情','貼紙','內容','版本'],
  '日記回覆': ['回覆ID','日記ID','回覆的人','內容','時間','版本'],
  '共同行事曆': ['約定ID','日期','活動名稱','類型','備註','倒數','建立者','最後修改者','版本'],
  '撲滿收支': ['交易ID','日期','類型','金額（元）','用途或來源','需要或想要','記錄者','版本'],
  '存錢願望': ['願望','目標金額（元）','修改者','版本']
};

// 第一次在 Apps Script 編輯器手動執行；bootstrapKey 只讀取腳本屬性，不寫進程式碼。
function setupFamily() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('ADMIN_BOOTSTRAP_TOKEN');
  if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('請先在腳本屬性填入 ADMIN_BOOTSTRAP_TOKEN（由家庭設定產生）。');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var book = SpreadsheetApp.openById(FAMILY_SHEET_ID);
    Object.keys(FAMILY_SCHEMA).forEach(function(name) { ensureSheet_(book,name); });
    var members = book.getSheetByName('家庭成員');
    if (members.getLastRow() > 1) throw new Error('家庭已初始化；不會重設或覆蓋既有成員。');
    var familyId = Utilities.getUuid();
    props.setProperty('FAMILY_ID',familyId);
    props.setProperty('FAMILY_NAME',props.getProperty('FAMILY_NAME') || '我們的小日子');
    members.appendRow([Utilities.getUuid(),safeText_(props.getProperty('ADMIN_NAME')||'媽媽'),'admin',hash_(token),true,new Date().toISOString()]);
    props.deleteProperty('ADMIN_BOOTSTRAP_TOKEN');
    SpreadsheetApp.flush();
    return '家庭初始化完成。請部署網頁應用程式，使用剛才產生的管理者連線碼連接。';
  } finally { lock.releaseLock(); }
}

function ensureSheet_(book,name) {
  var sheet = book.getSheetByName(name), headers = FAMILY_SCHEMA[name];
  if (!sheet) sheet = book.insertSheet(name);
  if (sheet.getLastRow() > 0) {
    var current = sheet.getRange(1,1,1,headers.length).getValues()[0];
    if (JSON.stringify(current) !== JSON.stringify(headers)) throw new Error('工作表「'+name+'」已有其他內容；已停止，請保留原內容並改名後重試。');
  } else {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    sheet.getRange(1,1,1,headers.length).setBackground('#966080').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);sheet.setColumnWidths(1,headers.length,140);
  }
  return sheet;
}

function doGet(e) {
  if(e&&e.parameter&&e.parameter.state&&(e.parameter.code||e.parameter.error)&&typeof lineCallback_==='function')return lineCallback_(e.parameter);
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><p>小日子家庭同步服務。請從親子手帳內輸入個別連線碼使用；此頁不公開家庭資料。</p>');
}
function doPost(e) {
  var request = {}, reply;
  try {
    var raw=(e.parameter||{}).payload || '{}';if(raw.length>60000)throw familyError_('REQUEST','連線請求太大，請分次同步。');
    request = JSON.parse(raw);
    if (request.origin !== FAMILY_ORIGIN) throw familyError_('ORIGIN','請從小日子正式網站連接。');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(request.requestId||'') || !/^[A-Za-z0-9_-]{20,100}$/.test(request.nonce||'')) throw familyError_('REQUEST','連線請求無效。');
    reply = handleFamily_(request);
    if(reply.ok&&(request.action==='apply'||request.action==='pull')&&typeof lineDrain_==='function'){try{lineDrain_();}catch(lineError){reply.lineWarning=true;}}
  } catch (error) {
    reply = {ok:false,error:{code:error.familyCode||'SERVER',message:error.familyCode?error.message:'同步服務暫時無法完成，請稍後再試。'}};
  }
  var message = JSON.stringify({channel:'ann-family-v1',requestId:request.requestId||'',nonce:request.nonce||'',reply:reply}).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage('+message+','+JSON.stringify(FAMILY_ORIGIN)+');</script>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleFamily_(request) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw familyError_('BUSY','其他家人正在儲存，請稍候再同步。');
  try {
    var book = SpreadsheetApp.openById(FAMILY_SHEET_ID);
    var membersSheet = ensureSheet_(book,'家庭成員');
    var members = rows_(membersSheet).map(function(r){return {id:r[0],name:r[1],role:r[2],hash:r[3],active:r[4]===true||r[4]==='TRUE',created:r[5]};});
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(request.token||''))throw familyError_('AUTH','請提供完整個人連線碼。');
    var digest = hash_(String(request.token));
    var member = members.filter(function(m){return m.active && equal_(m.hash,digest);})[0];
    if (!member) throw familyError_('AUTH','連線碼不正確或已停用；請向家人取得自己的新連線碼。');
    var log = ensureSheet_(book,'同步紀錄');
    var replay = replay_(rows_(log));
    if(String(request.action||'').indexOf('line.')===0&&typeof lineAction_==='function')return lineAction_(request,member,members,replay);
    if (request.action === 'member.add' || request.action === 'member.revoke') {
      if (member.role !== 'admin') throw familyError_('FORBIDDEN','只有家庭管理者可以管理成員。');
      if (request.action === 'member.add') {
        var name = text_(request.name,30,'名字'),role=request.role;
        if (role!=='parent'&&role!=='child') throw familyError_('VALIDATION','成員角色不正確。');
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(request.newToken||'')) throw familyError_('VALIDATION','新連線碼不正確。');
        var newHash=hash_(request.newToken);
        if (!members.some(function(m){return equal_(m.hash,newHash);})) {
          var newMember={id:Utilities.getUuid(),name:name,role:role,active:true,created:new Date().toISOString()};
          membersSheet.appendRow([newMember.id,safeText_(name),role,newHash,true,newMember.created]);members.push(newMember);
        }
      } else {
        var target=members.filter(function(m){return m.id===request.memberId;})[0];
        if (!target||target.role==='admin'||target.id===member.id) throw familyError_('VALIDATION','不能停用管理者或目前自己的連線碼。');
        membersSheet.getRange(members.indexOf(target)+2,5).setValue(false);target.active=false;
      }
    } else if (request.action === 'apply') {
      var operation=String(request.operation||'');
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(operation)) throw familyError_('VALIDATION','操作識別碼無效。');
      if (replay.operations[operation] && replay.operations[operation]!==member.id) throw familyError_('VALIDATION','操作識別碼已使用。');
      if (!replay.operations[operation]) {
        var changes=request.changes;
        if (!Array.isArray(changes)||!changes.length||changes.length>10||JSON.stringify(changes).length>40000) throw familyError_('VALIDATION','一次最多同步 10 筆、40,000 字的內容。');
        var next=JSON.parse(JSON.stringify(replay.records)),stamped=[],time=new Date().toISOString();
        changes.forEach(function(change){
          var kind=change.kind,id=String(change.id||''),key=kind+':'+id;
          if (['diary','reply','event','transaction','goal'].indexOf(kind)<0||!id||id.length>160||/^[=+@]/.test(id)) throw familyError_('VALIDATION','資料類型或識別碼不正確。');
          var before=next[key],version=before?before.version:0;
          if (version!==change.baseVersion) throw familyError_('CONFLICT','其他家人已修改相同紀錄，你的內容仍保存在手機，請先處理同步衝突。');
          if (before && kind!=='event' && before.value.authorId!==member.id && member.role==='child') throw familyError_('FORBIDDEN','孩子只能修改自己的日記、回覆和收支。');
          if (change.deleted && !before) throw familyError_('VALIDATION','找不到要移除的紀錄。');
          var value=change.deleted?before.value:validateValue_(kind,change.value,next);
          if (!change.deleted) {
            value.authorId=before?before.value.authorId:member.id;
            value.author=before?before.value.author:member.name;
            value.updatedBy=member.name;value.updatedAt=time;
          }
          var entry={kind:kind,id:id,version:version+1,deleted:!!change.deleted,value:value};
          next[key]=entry;stamped.push(entry);
        });
        var amount=Object.keys(next).reduce(function(sum,key){var r=next[key];return sum+(r.kind==='transaction'&&!r.deleted?(r.value.type==='in'?r.value.amount:-r.value.amount):0);},0);
        if (!Number.isSafeInteger(amount)||amount<0) throw familyError_('BALANCE','家人已更新撲滿；這次變更會讓餘額不足，尚未上傳。請重新整理並調整這筆紀錄。');
        // A batch is one appended row, so retries never duplicate partially applied writes.
        log.appendRow([operation,replay.revision+1,member.id,safeText_(member.name),time,JSON.stringify(stamped)]);
        SpreadsheetApp.flush();
        replay.records=next;replay.revision++;
      }
    } else if (request.action!=='pull') throw familyError_('ACTION','不支援的操作。');
    var projectionWarning=false,props=PropertiesService.getScriptProperties();
    try{if(props.getProperty('PROJECTED_REVISION')!==String(replay.revision)){project_(book,replay.records);props.setProperty('PROJECTED_REVISION',String(replay.revision));}}catch(error){projectionWarning=true;}
    SpreadsheetApp.flush();
    return {ok:true,familyId:props.getProperty('FAMILY_ID'),familyName:props.getProperty('FAMILY_NAME')||'我們的小日子',member:publicMember_(member),members:members.map(publicMember_),revision:replay.revision,records:replay.records,projectionWarning:projectionWarning};
  } finally {lock.releaseLock();}
}

function replay_(rows) {
  var records={},operations={},revision=0;
  rows.forEach(function(row){
    if (!row[0]) return;
    var changes=JSON.parse(row[5]);
    changes.forEach(function(record){records[record.kind+':'+record.id]=record;});
    operations[row[0]]=row[2];revision=Math.max(revision,Number(row[1])||0);
  });
  return {records:records,operations:operations,revision:revision};
}
function validateValue_(kind,input,records) {
  var v=input||{},out={};
  if (kind==='diary') {out.date=date_(v.date);out.text=text_(v.text,3000,'日記');out.mood=text_(v.mood,12,'心情');out.sticker=text_(v.sticker,12,'貼紙');out.created=Number(v.created)||Date.now();}
  if (kind==='reply') {out.diaryId=text_(v.diaryId,160,'日記ID');var parent=records['diary:'+out.diaryId];if(!parent||parent.deleted)throw familyError_('CONFLICT','這篇日記已移除，回覆未上傳。');out.text=text_(v.text,1000,'回覆');out.created=Number(v.created)||Date.now();}
  if (kind==='event') {out.date=date_(v.date);out.title=text_(v.title,80,'活動名稱');out.type=['outing','exam','birthday','other'].indexOf(v.type)>=0?v.type:'other';out.note=optionalText_(v.note,500);out.count=!!v.count;}
  if (kind==='transaction') {out.date=date_(v.date);out.type=v.type;if(out.type!=='in'&&out.type!=='out')throw familyError_('VALIDATION','收支類型不正確。');out.amount=Number(v.amount);if(!Number.isSafeInteger(out.amount)||out.amount<1||out.amount>9999999)throw familyError_('VALIDATION','金額必須是有效整數。');out.note=text_(v.note,80,'用途或來源');out.need=optionalText_(v.need,30);out.created=Number(v.created)||Date.now();}
  if (kind==='goal') {out.name=text_(v.name,60,'願望');out.amount=Number(v.amount);if(!Number.isSafeInteger(out.amount)||out.amount<1||out.amount>9999999)throw familyError_('VALIDATION','目標金額不正確。');}
  return out;
}
function project_(book,records) {
  var grouped={};Object.keys(FAMILY_SCHEMA).forEach(function(name){grouped[name]=[];});
  Object.keys(records).sort().forEach(function(key){var r=records[key],v=r.value;if(r.deleted)return;
    if(r.kind==='diary')grouped['家庭日記'].push([r.id,v.date,v.author,v.mood,v.sticker,v.text,r.version]);
    if(r.kind==='reply'){var parent=records['diary:'+v.diaryId];if(parent&&!parent.deleted)grouped['日記回覆'].push([r.id,v.diaryId,v.author,v.text,new Date(v.created).toISOString(),r.version]);}
    if(r.kind==='event')grouped['共同行事曆'].push([r.id,v.date,v.title,v.type,v.note,v.count,v.author,v.updatedBy,r.version]);
    if(r.kind==='transaction')grouped['撲滿收支'].push([r.id,v.date,v.type==='in'?'存入':'支出',v.amount,v.note,v.need,v.author,r.version]);
    if(r.kind==='goal')grouped['存錢願望'].push([v.name,v.amount,v.updatedBy,r.version]);
  });
  Object.keys(grouped).filter(function(n){return n!=='家庭成員'&&n!=='同步紀錄';}).forEach(function(name){
    var s=ensureSheet_(book,name),cols=FAMILY_SCHEMA[name].length,rows=grouped[name];
    if(s.getLastRow()>1)s.getRange(2,1,s.getLastRow()-1,cols).clearContent();
    if(rows.length)s.getRange(2,1,rows.length,cols).setValues(rows.map(function(row){return row.map(safeText_);}));
  });
}
function rows_(sheet){return sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues():[];}
function safeText_(v){return typeof v==='string'&&/^[=+\-@\t\r]/.test(v)?"'"+v:v;}
function text_(v,max,label){var s=String(v==null?'':v).trim();if(!s||s.length>max)throw familyError_('VALIDATION',label+'未填寫或太長。');return s;}
function optionalText_(v,max){var s=String(v==null?'':v);if(s.length>max)throw familyError_('VALIDATION','備註太長。');return s;}
function date_(v){var s=String(v||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||isNaN(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw familyError_('VALIDATION','日期不正確。');return s;}
function hash_(token){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(token),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function equal_(a,b){if(typeof a!=='string'||a.length!==b.length)return false;var diff=0;for(var i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
function publicMember_(m){return {id:m.id,name:m.name,role:m.role,active:m.active};}
function familyError_(code,message){var error=new Error(message);error.familyCode=code;return error;}
