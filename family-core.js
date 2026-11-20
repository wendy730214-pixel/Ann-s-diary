(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AnnFamilyCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const clone=value=>JSON.parse(JSON.stringify(value));
 const empty=()=>({diaries:[],events:[],transactions:[],goal:null});
 const key=r=>r.kind+':'+r.id;
 const stable=value=>JSON.stringify(value,Object.keys(value).sort());
 function visible(records){return Object.values(records).filter(r=>!r.deleted);}
 function project(records){
  const state=empty(),rows=visible(records);
  state.diaries=rows.filter(r=>r.kind==='diary').map(r=>({...clone(r.value),id:r.id,version:r.version,replies:[]}));
  const diaries=new Map(state.diaries.map(d=>[d.id,d]));
  for(const r of rows.filter(r=>r.kind==='reply')){const d=diaries.get(r.value.diaryId);if(d)d.replies.push({...clone(r.value),id:r.id,version:r.version});}
  for(const d of state.diaries)d.replies.sort((a,b)=>(a.created||0)-(b.created||0)||a.id.localeCompare(b.id));
  state.events=rows.filter(r=>r.kind==='event').map(r=>({...clone(r.value),id:r.id,version:r.version}));
  state.transactions=rows.filter(r=>r.kind==='transaction').map(r=>({...clone(r.value),id:r.id,version:r.version}));
  const goal=rows.find(r=>r.kind==='goal');state.goal=goal?{...clone(goal.value),id:goal.id,version:goal.version}:null;
  return state;
 }
 function flatten(state,makeId){
  const records={};
  function add(kind,id,value){const copy=clone(value);delete copy.id;delete copy.version;delete copy.replies;records[kind+':'+id]={kind,id,value:copy};}
  for(const d of state.diaries){add('diary',d.id,d);for(const r of d.replies||[]){if(!r.id)r.id=makeId();if(!r.created)r.created=Date.now();add('reply',r.id,{...r,diaryId:d.id});}}
  for(const e of state.events)add('event',e.id,e);
  for(const t of state.transactions)add('transaction',t.id,t);
  if(state.goal)add('goal','shared-goal',state.goal);
  return records;
 }
 function valueEqual(a,b){
  const fields=v=>{const copy={...v};delete copy.authorId;delete copy.author;delete copy.updatedBy;delete copy.updatedAt;return stable(copy);};
  return fields(a)===fields(b);
 }
 function changesFrom(before,after,records,makeId,member){
  const old=flatten(before,makeId),next=flatten(after,makeId),changes=[];
  const removedDiaries=new Set(Object.values(old).filter(r=>r.kind==='diary'&&!next[key(r)]).map(r=>r.id));
  for(const [k,r]of Object.entries(next)){
   if(!old[k]||!valueEqual(old[k].value,r.value)){
    const saved=records[k],value={...r.value};
    value.authorId=saved?saved.value.authorId:member.id;value.author=saved?saved.value.author:member.name;
    changes.push({kind:r.kind,id:r.id,baseVersion:saved?saved.version:0,deleted:false,value});
   }
  }
  for(const [k,r]of Object.entries(old))if(!next[k]&&!(r.kind==='reply'&&removedDiaries.has(r.value.diaryId)))changes.push({kind:r.kind,id:r.id,baseVersion:records[k]?records[k].version:0,deleted:true});
  return changes;
 }
 function apply(records,changes,member){
  const next=clone(records);
  for(const c of changes){const k=c.kind+':'+c.id,old=next[k];next[k]={kind:c.kind,id:c.id,version:c.baseVersion+1,deleted:c.deleted,value:c.deleted?clone(old?.value||{}):{...clone(c.value),updatedBy:member.name}};}
  return next;
 }
 class Engine{
  constructor({request,storage,cacheKey,makeId,onChange}){this.request=request;this.storage=storage;this.cacheKey=cacheKey;this.makeId=makeId;this.onChange=onChange||(()=>{});this.records={};this.serverRecords={};this.queue=[];this.error=null;this.flushing=false;this.meta=null;}
  persist(){this.storage.setItem(this.cacheKey,JSON.stringify({serverRecords:this.serverRecords,queue:this.queue,meta:this.meta}));}
  restore(){const raw=this.storage.getItem(this.cacheKey);if(!raw)return false;const v=JSON.parse(raw);if(!v||!Array.isArray(v.queue)||!v.serverRecords||!v.meta?.member)throw Error('家庭手機快取無法讀取，請先保留備份。');this.meta=v.meta;this.serverRecords=v.serverRecords;this.queue=v.queue;this.rebase();return true;}
  rebase(){this.records=clone(this.serverRecords);if(this.error?.blocking)return;for(const q of this.queue)this.records=apply(this.records,q.changes,this.meta.member);}
  state(){return project(this.records);}
  async initialize(){const cached=this.restore();try{const reply=await this.request({action:'pull'});this.accept(reply);this.rebase();this.persist();this.error=null;this.onChange();return reply;}catch(error){if(!cached)throw error;this.error={code:error.code||'NETWORK',message:error.message||'目前離線，已載入這台手機的家庭紀錄。',blocking:['AUTH','FORBIDDEN'].includes(error.code)};this.onChange();return {offline:true};}}
  accept(reply){if(!reply.ok){const e=new Error(reply.error?.message||'家庭同步失敗');e.code=reply.error?.code||'SERVER';throw e;}this.meta={familyId:reply.familyId,familyName:reply.familyName,member:reply.member,members:reply.members,revision:reply.revision,projectionWarning:reply.projectionWarning,syncedAt:Date.now()};this.serverRecords=clone(reply.records);}
  save(before,after){
   const proposed=clone(after),changes=changesFrom(clone(before),proposed,this.records,this.makeId,this.meta.member);
   if(!changes.length)return false;
   const previous={queue:clone(this.queue),records:clone(this.records)};
   try{
    for(let i=0;i<changes.length;i+=10){const batch=changes.slice(i,i+10);if(JSON.stringify(batch).length>40000)throw Error('內容太多，請分次儲存。');this.queue.push({operation:this.makeId(),changes:batch});this.records=apply(this.records,batch,this.meta.member);}
    this.persist();
   }catch(e){this.queue=previous.queue;this.records=previous.records;throw e;}
   this.error=null;this.onChange();return true;
  }
  async flush(){
   if(this.flushing||!this.queue.length||this.error?.blocking)return;
   this.flushing=true;this.onChange();
   try{
    while(this.queue.length){
     const operation=this.queue[0];const reply=await this.request({action:'apply',...operation});
     this.accept(reply);this.queue.shift();this.rebase();this.persist();this.error=null;this.onChange();
    }
   }catch(e){this.error={code:e.code||'NETWORK',message:e.message,blocking:['CONFLICT','BALANCE','AUTH','FORBIDDEN','VALIDATION'].includes(e.code)};if(this.error.blocking){try{if(e.code!=='AUTH')this.accept(await this.request({action:'pull'}));this.rebase();this.persist();}catch(refreshError){/* Keep the pending copy if refreshing is unavailable. */}}this.onChange();}
   finally{this.flushing=false;this.onChange();}
  }
  async pull(){if(this.flushing)return;try{const reply=await this.request({action:'pull'});this.accept(reply);this.rebase();this.persist();if(!this.queue.length)this.error=null;this.onChange();}catch(e){this.error={code:e.code||'NETWORK',message:e.message,blocking:e.code==='AUTH'};this.onChange();}}
  async useCloud(){const reply=await this.request({action:'pull'});this.accept(reply);this.queue=[];this.error=null;this.rebase();this.persist();this.onChange();}
 }
 return {Engine,empty,project,flatten,changesFrom,apply};
});
