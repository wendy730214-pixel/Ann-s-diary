/* 家庭模式只使用個別連線碼；不把帳密或家庭資料放進公開儲存庫。 */
(() => {
 'use strict';
 const Core=AnnFamilyCore,CONFIG_KEY='ann-family-connection-v1';
 const localSave=save,localRender=render,localToast=toast,localCheck=checkStorage;
 let personal=JSON.parse(JSON.stringify(state));
 let engine=null,connection=null,timer=null,savingFormKey=null,lastSync='',inviteText='';
 const copy=v=>JSON.parse(JSON.stringify(v));
 function randomToken(bytes=32){const a=new Uint8Array(bytes);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
 function endpoint(value){const u=new URL(value);if(u.protocol==='https:'&&u.hostname==='script.google.com'&&/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u.pathname)&&!u.search&&!u.hash&&!u.username)return u.href;throw Error('請使用 Google Apps Script 部署的 /exec 網址。');}
 function googleResponse(origin){return /^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(origin)||origin==='https://script.google.com';}
 function rpc(config,data){
  return new Promise((resolve,reject)=>{
   const requestId=randomToken(24),nonce=randomToken(24),frame=document.createElement('iframe'),form=document.createElement('form'),input=document.createElement('input');
   frame.name='family-'+requestId;frame.hidden=true;frame.title='家庭同步';
   form.method='POST';form.action=config.endpoint;form.target=frame.name;form.hidden=true;
   input.type='hidden';input.name='payload';input.value=JSON.stringify({...data,token:config.token,origin:location.origin,requestId,nonce});form.appendChild(input);
   const cleanup=()=>{clearTimeout(timeout);window.removeEventListener('message',onMessage);form.remove();frame.remove();};
   const onMessage=event=>{const message=event.data;if(!googleResponse(event.origin)||!message||message.channel!=='ann-family-v1'||message.requestId!==requestId||message.nonce!==nonce)return;cleanup();const r=message.reply;if(!r?.ok){const error=new Error(r?.error?.message||'家庭同步未完成');error.code=r?.error?.code||'SERVER';reject(error);}else resolve(r);};
   const timeout=setTimeout(()=>{cleanup();reject(Error('家庭同步逾時；請保持連線後重試。若是第一次設定，請確認 Apps Script 已部署給「所有人」執行。'));},35000);
   window.addEventListener('message',onMessage);document.body.append(frame,form);form.submit();
  });
 }
 function formKey(form){return form.id||form.dataset.reply||'';}
 function drafts(){return [...document.querySelectorAll('main form')].filter(f=>formKey(f)!==savingFormKey&&(f.dataset.familyDirty==='1'||f.matches('[data-reply]')&&f.elements.text?.value.trim())).map(f=>({key:formKey(f),fields:[...f.elements].filter(x=>x.name||x.id).map(x=>({key:x.id||x.name,value:x.value,checked:x.checked}))}));}
 function restoreDrafts(saved){for(const d of saved){const f=[...document.querySelectorAll('main form')].find(x=>formKey(x)===d.key);if(!f)continue;f.dataset.familyDirty='1';for(const v of d.fields){const input=[...f.elements].find(x=>(x.id||x.name)===v.key);if(input){input.value=v.value;if(typeof v.checked==='boolean')input.checked=v.checked;}}}}
 function decorate(){
  if(!engine?.meta)return;
  const me=engine.meta.member;
  document.querySelectorAll('[data-reply]').forEach(f=>{const select=f.elements.author;select.replaceChildren();const option=document.createElement('option');option.textContent=me.name;option.value=me.name;select.appendChild(option);select.disabled=true;});
  for(const diary of state.diaries){const b=[...document.querySelectorAll('[data-delete-diary]')].find(x=>x.dataset.deleteDiary===diary.id);if(b&&me.role==='child'&&diary.authorId!==me.id){b.disabled=true;b.title='只能刪除自己的日記';}}
  for(const transaction of state.transactions){const b=[...document.querySelectorAll('[data-undo]')].find(x=>x.dataset.undo===transaction.id);if(b&&me.role==='child'&&transaction.authorId!==me.id){b.disabled=true;b.title='只能撤銷自己的收支';}}
 }
 render=function(){const pendingDrafts=drafts();localRender();decorate();restoreDrafts(pendingDrafts);};
 function syncView(){
  if(!engine?.meta)return;
  state=engine.state();render();
  const n=engine.queue.length,error=engine.error;
  if(engine.meta.syncedAt)lastSync=new Date(engine.meta.syncedAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'});
  $('#family-name').textContent=engine.meta.familyName;
  $('#family-person').textContent=engine.meta.member.name+' · '+({admin:'管理者',parent:'家長',child:'孩子'}[engine.meta.member.role]);
  $('#family-status').textContent=error?error.message:n?'已存手機，'+n+' 批內容待同步到 Google 試算表':engine.flushing?'正在同步到 Google 試算表……':engine.meta.projectionWarning?'紀錄已寫入同步表；試算表檢視尚未更新，請稍後重新整理。':'已同步到 Google 試算表'+(lastSync?' · '+lastSync:'');
  $('#family-status').dataset.kind=error?'error':n?'pending':'success';
  $('#family-resolve').hidden=!error?.blocking;$('#family-pending-export').hidden=!n;
  $('#family-refresh').hidden=false;
  $('#family-disconnected').hidden=true;$('#family-connected').hidden=false;
  $('#family-member-tools').hidden=engine.meta.member.role!=='admin';
  $('#storage-status').textContent=n?'紀錄已保留在這台手機；待上傳完成後，其他家人才看得到。':'家庭共用模式：'+engine.meta.member.name+'，家人可看到已同步的紀錄。';
  $('#storage-status').dataset.kind=error?'error':'info';
  if(!n&&!error)document.querySelectorAll('.form-feedback[data-family-pending="1"]').forEach(panel=>{panel.textContent='✅ 已同步到 Google 試算表，家人現在可以查看這筆紀錄。';panel.dataset.familyPending='';});
  $('#family-members').replaceChildren();
  for(const member of engine.meta.members){const item=document.createElement('div');item.className='family-member';const label=document.createElement('span');label.textContent=member.name+' · '+({admin:'管理者',parent:'家長',child:'孩子'}[member.role])+(member.active?'':'（已停用）');item.appendChild(label);if(engine.meta.member.role==='admin'&&member.role!=='admin'&&member.active){const b=document.createElement('button');b.type='button';b.className='small danger';b.textContent='停用';b.onclick=async()=>{if(!confirm('停用 '+member.name+' 的連線碼？對方手機尚未同步的內容會繼續保留在當地。'))return;try{await rpc(connection,{action:'member.revoke',memberId:member.id});await engine.pull();}catch(e){dialogMessage(e.message);}};item.appendChild(b);}$('#family-members').appendChild(item);}
 }
 toast=function(message,kind='info'){
  if(engine&&kind==='success')message=engine.queue.length?'✅ 已存到這台手機，正在等待同步。看到上方「已同步到 Google 試算表」後，家人才看得到。':message;
  localToast(message,kind);
  if(engine&&kind==='success'&&activeSaveForm){const panel=activeSaveForm.querySelector('.form-feedback');if(panel)panel.dataset.familyPending=engine.queue.length?'1':'';}
 };
 save=function(change){
  if(!engine){const accepted=localSave(change);if(accepted)personal=copy(state);return accepted;}
  if(engine.error?.blocking){toast('目前有待處理的同步問題，請先點「處理同步問題」。你的輸入內容仍保留。','error');return false;}
  const before=copy(state);savingFormKey=activeSaveForm?formKey(activeSaveForm):null;
  try{change();const accepted=engine.save(before,state);if(activeSaveForm)activeSaveForm.dataset.familyDirty='';state=engine.state();if(accepted)void engine.flush().then(()=>{if(!engine.queue.length&&!engine.error){lastSync=new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'});syncView();}});return true;}
  catch(error){state=before;toast('尚未儲存：'+error.message,'error');return false;}
  finally{savingFormKey=null;}
 };
 document.addEventListener('input',e=>{const f=e.target.closest('main form');if(f)f.dataset.familyDirty='1';});
 document.addEventListener('change',e=>{const f=e.target.closest('main form');if(f)f.dataset.familyDirty='1';});
 document.addEventListener('submit',e=>{if(e.target.closest('main'))activeSaveForm=e.target;},true);
 function dialogMessage(message){$('#family-dialog-status').textContent=message;}
 function openSettings(){dialogMessage('');$('#family-dialog').showModal();if(engine)syncView();}
 $('#family-open').onclick=openSettings;
 $('#family-close').onclick=()=>{$('#family-dialog').close();};
 $('#family-connect-form').onsubmit=async e=>{e.preventDefault();const button=$('#family-connect');button.disabled=true;dialogMessage('正在驗證家庭連線……');try{
  const config={endpoint:endpoint($('#family-endpoint').value.trim()),token:$('#family-token').value.trim()};
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(config.token))throw Error('請貼上你自己的完整家庭連線碼。');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(config.endpoint+'\n'+config.token));
  const cacheKey='ann-family-cache:'+Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const next=new Core.Engine({request:data=>rpc(config,data),storage:localStorage,cacheKey,makeId:()=>randomToken(24),onChange:()=>{if(engine===next)syncView();}});
  await next.initialize();
  localStorage.setItem(CONFIG_KEY,JSON.stringify(config));engine=next;connection=config;lastSync=new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'});syncView();
  $('#family-connect-form').hidden=true;$('#family-account').hidden=false;$('#family-dialog').close();startPolling();void engine.flush();
 }catch(error){dialogMessage(error.message);}finally{button.disabled=false;}};
 function startPolling(){clearInterval(timer);timer=setInterval(()=>{if(document.visibilityState==='visible'&&navigator.onLine&&engine){void engine.pull();void engine.flush();}},20000);}
 $('#family-refresh').onclick=async()=>{if(!engine)return;await engine.pull();await engine.flush();};
 window.addEventListener('online',()=>{if(engine){void engine.pull();void engine.flush();}});
 document.addEventListener('visibilitychange',()=>{if(engine&&document.visibilityState==='visible'){void engine.pull();void engine.flush();}});
 function downloadJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 $('#family-pending-export').onclick=()=>{if(engine)downloadJSON({familyName:engine.meta.familyName,member:engine.meta.member,queue:engine.queue,state:engine.state()},'小日子待同步備份-'+localDate()+'.json');};
 $('#family-resolve').onclick=async()=>{if(!engine)return;openSettings();dialogMessage('有內容與家人更新的版本衝突。你的待同步內容仍保留在這台手機，可先下載備份，再選擇載入雲端版本。');$('#family-conflict-tools').hidden=false;};
 $('#family-cloud-reset').onclick=async()=>{if(!engine||!confirm('確定改用雲端版本？請先下載待同步備份；這會移除本機待同步佇列。'))return;try{await engine.useCloud();$('#family-conflict-tools').hidden=true;dialogMessage('已載入家人目前的版本。');}catch(e){dialogMessage(e.message);}};
 $('#family-dialog-export').onclick=()=>$('#family-pending-export').click();
 $('#family-signout').onclick=()=>{if(engine?.queue.length){dialogMessage('還有待同步內容，請先完成同步，或下載備份並處理衝突後再離開家庭。');return;}if(!confirm('在這台裝置離開家庭共用？家庭雲端紀錄會保留。'))return;clearInterval(timer);localStorage.removeItem(CONFIG_KEY);engine=null;connection=null;state=copy(personal);render();localCheck();$('#family-connected').hidden=true;$('#family-disconnected').hidden=false;$('#family-connect-form').hidden=false;$('#family-account').hidden=true;$('#family-name').textContent='家庭共用';$('#family-person').textContent='尚未連接';$('#family-refresh').hidden=true;$('#family-dialog').close();};
 function inviteLink(token){const data=JSON.stringify({endpoint:connection.endpoint,token});const encoded=btoa(String.fromCharCode(...new TextEncoder().encode(data))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');return new URL('./',location.href).href.split('#')[0]+'#ann-family='+encoded;}
 $('#family-own-link').onclick=async()=>{if(!connection)return;try{await navigator.clipboard.writeText(inviteLink(connection.token));dialogMessage('已複製你自己的連線連結，請只傳到你本人的其他裝置。家人請使用各自的邀請連結。');}catch(e){$('#family-own-link-value').value=inviteLink(connection.token);$('#family-own-link-output').hidden=false;$('#family-own-link-value').focus();$('#family-own-link-value').select();dialogMessage('請長按連結欄位複製，並只存到你本人的其他裝置。');}};
 $('#family-add-member').onsubmit=async e=>{e.preventDefault();if(!engine)return;dialogMessage('正在新增成員……');const token=randomToken();try{await rpc(connection,{action:'member.add',name:$('#family-new-name').value.trim(),role:$('#family-new-role').value,newToken:token});inviteText=inviteLink(token);$('#family-invite-link').value=inviteText;$('#family-invite-box').hidden=false;$('#family-new-name').value='';await engine.pull();dialogMessage('成員已加入。請私下傳送這份個人邀請連結，持有連結的人可以讀取家庭紀錄。');}catch(e){dialogMessage(e.message);}};
 $('#family-copy-invite').onclick=async()=>{try{await navigator.clipboard.writeText($('#family-invite-link').value);dialogMessage('已複製個人邀請連結。');}catch(e){$('#family-invite-link').focus();$('#family-invite-link').select();dialogMessage('請長按連結欄位，選擇複製。');}};
 $('#family-generate-key').onclick=()=>{$('#family-bootstrap-key').value=randomToken();$('#family-bootstrap-output').hidden=false;};
 $('#family-copy-key').onclick=async()=>{try{await navigator.clipboard.writeText($('#family-bootstrap-key').value);dialogMessage('已複製管理者連線碼，請只存到你自己的 Apps Script 腳本屬性。');}catch(e){$('#family-bootstrap-key').focus();$('#family-bootstrap-key').select();}};
 $('#family-import').onclick=()=>{
  if(!engine)return;const source=personal;if(!source.diaries.length&&!source.events.length&&!source.transactions.length&&!source.goal){dialogMessage('這台裝置沒有舊的個人紀錄可以加入家庭。');return;}
  const summary='將這台裝置的 '+source.diaries.length+' 篇日記、'+source.events.length+' 個約定、'+source.transactions.length+' 筆收支加入「'+engine.meta.familyName+'」？所有家庭成員都能看見；不會移除原本個人模式的紀錄。';
  if(!confirm(summary))return;
  activeSaveForm=null;const accepted=save(()=>{for(const field of ['diaries','events','transactions']){const ids=new Set(state[field].map(x=>x.id));state[field].push(...copy(source[field].filter(x=>!ids.has(x.id))));}if(!state.goal&&source.goal)state.goal=copy(source.goal);});if(accepted)dialogMessage('舊紀錄已加入手機待同步佇列，請等候上方顯示已同步。');
 };
 // Shared calendar: everyone may maintain an appointment; versions prevent silent overwrites.
 document.addEventListener('click',event=>{const button=event.target.closest('[data-edit-event]');if(!button)return;const entry=state.events.find(e=>e.id===button.dataset.editEvent);if(!entry)return;$('#event-edit-id').value=entry.id;$('#event-title').value=entry.title;$('#event-date').value=entry.date;$('#event-type').value=entry.type;$('#event-note').value=entry.note||'';$('#event-count').checked=entry.count;$('#event-form').dataset.familyDirty='1';$('#event-submit').textContent='儲存約定修改';$('#event-form').scrollIntoView({block:'start',behavior:'smooth'});});
 $('#event-cancel-edit').onclick=()=>{$('#event-edit-id').value='';$('#event-submit').textContent='存下我們的約定';$('#event-title').value='';$('#event-note').value='';$('#event-form').dataset.familyDirty='';};
 $('#event-form').onsubmit=event=>{event.preventDefault();activeSaveForm=$('#event-form');if(!activeSaveForm.checkValidity()){toast('請填寫活動名稱與日期。','error');activeSaveForm.reportValidity();return;}const title=$('#event-title').value.trim();if(!title)return toast('請填寫活動名稱。','error');const date=$('#event-date').value,entryId=$('#event-edit-id').value;const data={title,date,type:$('#event-type').value,note:$('#event-note').value.trim(),count:$('#event-count').checked};if(save(()=>{if(entryId){const entry=state.events.find(e=>e.id===entryId);if(!entry)throw Error('這個約定已移除，請重新整理。');Object.assign(entry,data);}else state.events.push({id:id(),...data});})){month=new Date(date+'T12:00:00');month.setDate(1);renderCalendar();$('#event-cancel-edit').click();toast('✅ 約定已保存。','success');}};
 async function boot(){
  try{
   let config=null;
   if(location.hash.startsWith('#ann-family=')){const raw=location.hash.slice('#ann-family='.length);if(raw.length>4000)throw Error('邀請連結太長。');const json=new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));config=JSON.parse(json);history.replaceState(null,'',location.pathname+location.search);$('#family-endpoint').value=endpoint(config.endpoint);$('#family-token').value=config.token||'';openSettings();dialogMessage('已收到個人邀請連結，點「連接家庭」驗證並加入。');return;}
   const raw=localStorage.getItem(CONFIG_KEY);if(!raw)return;config=JSON.parse(raw);$('#family-endpoint').value=config.endpoint;$('#family-token').value=config.token;$('#family-connect-form').requestSubmit();
  }catch(error){$('#family-status').textContent=error.message;$('#family-status').dataset.kind='error';}
 }
 void boot();
})();
