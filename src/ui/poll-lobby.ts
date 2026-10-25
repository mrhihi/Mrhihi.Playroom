/** Voting lobby only; injected before the shared client router runs. */
export const pollLobbyScript = String.raw`
const pollLobbyModeLabel = mode => mode === 'scrum' ? 'Scrum 估點' : '一般投票';
const pollLobbyBlankOptions = () => [{label:'',point:'?'},{label:'',point:'?'}];
let pollLobbyDraft;
function pollLobbyCapture(scope) {
 const draft=pollLobbyDraft;
 draft.name=scope.querySelector('#poll-name').value;
 draft.question=scope.querySelector('#poll-question').value;
 draft.password=scope.querySelector('#poll-password').value;
 draft.observer=scope.querySelector('[name="poll-role"]:checked').value==='observer';
 draft.options[draft.mode]=[...scope.querySelectorAll('.poll-lobby-answer')].map(row=>({label:row.querySelector('.poll-answer-name').value,point:row.querySelector('.poll-answer-point')?.value??'?'}));
}
function pollLobbyOptionsView(scope) {
 const draft=pollLobbyDraft,scrum=draft.mode==='scrum',rows=draft.options[draft.mode];
 scope.querySelector('#poll-lobby-options').innerHTML=rows.map((option,index)=>'<div class="poll-lobby-answer"><span class="poll-answer-number" aria-hidden="true">'+(index+1)+'</span><div><label for="poll-answer-'+index+'">答項 '+(index+1)+'</label><input id="poll-answer-'+index+'" class="poll-answer-name" maxlength="80" value="'+esc(option.label)+'" aria-describedby="poll-answer-error-'+index+'"><small id="poll-answer-error-'+index+'" class="poll-field-error"></small></div>'+(scrum?'<div class="poll-point-field"><label for="poll-point-'+index+'">點數</label><input id="poll-point-'+index+'" class="poll-answer-point" inputmode="text" placeholder="數字或 ?" value="'+esc(option.point??'?')+'" aria-describedby="poll-point-error-'+index+'"><small id="poll-point-error-'+index+'" class="poll-field-error"></small></div>':'')+'<button type="button" class="secondary poll-remove" data-poll-action="remove" data-index="'+index+'" aria-label="移除答項 '+(index+1)+'" '+(rows.length<=2?'disabled':'')+'>×</button></div>').join('');
 scope.querySelector('#poll-common-points').hidden=!scrum;
 scope.querySelector('.poll-answer-columns').classList.toggle('with-points',scrum);
 scope.querySelector('.poll-answer-column-point').hidden=!scrum;
 scope.querySelector('#poll-question').placeholder=scrum?'例如：新增訂單查詢功能':'例如：下次聚餐要吃什麼？';
 scope.querySelectorAll('[data-poll-mode]').forEach(card=>{const selected=card.dataset.pollMode===draft.mode;card.classList.toggle('selected',selected);card.querySelector('.poll-mode-check').textContent=selected?'✓ 已選擇':'';card.querySelector('input').checked=selected});
 pollLobbySummary(scope);
}
function pollLobbySummary(scope) {
 const draft=pollLobbyDraft,count=[...scope.querySelectorAll('.poll-answer-name')].filter(input=>input.value.trim()).length;
 scope.querySelector('#poll-create-summary').textContent=pollLobbyModeLabel(draft.mode)+' · '+count+' 個答項 · '+(draft.observer?'局主只當觀察者':'局主參與投票');
 const preview=scope.querySelector('#poll-answer-preview');
 preview.hidden=count===0;
 preview.innerHTML=draft.options[draft.mode].filter(option=>option.label.trim()).map(option=>{const label=option.label.trim(),point=String(option.point??'?').trim();return '<span>'+esc(label)+(draft.mode==='scrum'&&label!==point?' <b>· '+esc(point)+'</b>':'')+'</span>'}).join('');
 scope.querySelector('#poll-answer-editor-count').textContent=' · '+count+' 個答項';
}
function pollLobbyClearErrors(scope) {
 scope.querySelectorAll('.poll-field-error').forEach(node=>node.textContent='');
 scope.querySelectorAll('[aria-invalid]').forEach(node=>node.removeAttribute('aria-invalid'));
 scope.querySelector('#poll-create-error').textContent='';
}
function pollLobbyValidate(scope,forCreate) {
 pollLobbyCapture(scope);pollLobbyClearErrors(scope);
 const draft=pollLobbyDraft;let first;
 const fail=(id,message)=>{const input=scope.querySelector('#'+id),errorId=/-(\d+)$/.test(id)?id.replace(/-(\d+)$/,'-error-$1'):id+'-error';input.setAttribute('aria-invalid','true');scope.querySelector('#'+errorId).textContent=message;first??=input};
 if(forCreate&&!draft.question.trim())fail('poll-question','請填寫第一題題目。');
 const options=draft.options[draft.mode].map((option,index)=>{
  const label=option.label.trim(),raw=String(option.point??'?').trim();
  if(!label)fail('poll-answer-'+index,'請填寫答項名稱，或移除此列。');
  if(draft.mode==='scrum'&&raw!=='?'&&(!raw||!Number.isFinite(Number(raw))))fail('poll-point-'+index,'請填寫有限數字或 ?。');
  return {id:'o'+index,label,...(draft.mode==='scrum'?{point:raw==='?'?null:Number(raw)}:{})};
 });
 if(forCreate&&!draft.name.trim())fail('poll-name','請填寫你的暱稱。');
 if(options.length<2)scope.querySelector('#poll-create-error').textContent='至少需要兩個答項。';
 if(first){const detail=first.closest('details');if(detail)detail.open=true;first.focus();return;}
 if(options.length<2)return;
 return {mode:draft.mode,options,...(forCreate?{question:draft.question.trim(),hostObserver:draft.observer}:{})};
}
async function pollLobbyCreate(scope) {
 if(pollLobbyDraft.creating)return;
 const config=pollLobbyValidate(scope,true);if(!config)return;
 const draft=pollLobbyDraft,button=scope.querySelector('#poll-create');
 draft.creating=true;button.disabled=true;button.textContent='建立中…';
 try {
  localStorage.setItem('playroom:name',draft.name.trim());
  const data=await api('/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({game:'poll',name:draft.name.trim(),password:draft.password,observer:draft.observer,config,identityId:browserIdentity(),deviceInfo:detectDevice()})});
  remember(data.roomId);put('playroom:token:'+data.roomId,data.reconnectToken);
  if(data.ownerDeleteToken)localStorage.setItem('playroom:owner:'+data.roomId,data.ownerDeleteToken);
  if(data.accessToken)put('playroom:access:'+data.roomId,data.accessToken);
  navigate(data.url);
 } catch(error) {scope.querySelector('#poll-create-error').textContent=error.message||'無法建立房間，請再試一次。';}
 finally {draft.creating=false;button.disabled=false;button.textContent='建立投票房間';}
}
async function pollLobbyLoadTemplates(scope) {
 const list=scope.querySelector('#poll-template-list');
 if(list.dataset.loading==='true'){await pollLobbyDraft.templateLoading;if(scope.isConnected)return pollLobbyLoadTemplates(scope);return;}
 list.dataset.loading='true';list.innerHTML='<p class="muted" role="status">正在載入範本…</p>';
 const ids=[...new Set(local('playroom:templates',[]))];
 const pending=Promise.allSettled(ids.map(id=>api('/api/templates/'+encodeURIComponent(id))));
 pollLobbyDraft.templateLoading=pending;
 const results=await pending;
 if(!scope.isConnected)return;
 const templates=results.filter(result=>result.status==='fulfilled').map(result=>result.value).filter(item=>item.game==='poll');
 pollLobbyDraft.templates=new Map(templates.map(item=>[item.id,item]));
 list.innerHTML=templates.map(item=>{
  const options=Array.isArray(item.config?.options)?item.config.options:[],mode=item.config?.mode==='scrum'?'scrum':'standard';
  const summary=options.slice(0,5).map(option=>String(option.label??'')+(mode==='scrum'?' ('+(option.point??'?')+')':'')).join('、')+(options.length>5?'…':'');
  return '<article class="poll-template-item"><h4>'+pollLobbyModeLabel(mode)+' · '+options.length+' 個答項</h4><p>'+esc(summary||'沒有答項')+'</p><small>範本 ID：'+esc(item.id)+'</small><div class="poll-inline-actions"><button type="button" class="secondary" data-poll-action="apply-template" data-id="'+esc(item.id)+'">套用範本</button><button type="button" class="secondary" data-poll-action="delete-template" data-id="'+esc(item.id)+'">刪除範本</button></div></article>';
 }).join('')||'<p class="muted">尚無投票答項範本，可將目前答項儲存起來。</p>';
 if(results.some(result=>result.status==='rejected'))list.insertAdjacentHTML('beforeend','<p class="poll-field-error" role="status">部分範本無法載入，可能已被刪除。</p><button type="button" class="secondary" data-poll-action="reload-templates">重新載入範本</button>');
 list.dataset.loading='false';
}
async function pollLobbySaveTemplate(scope,button) {
 const config=pollLobbyValidate(scope,false);if(!config)return;
 button.disabled=true;
 try {
  const data=await api('/api/templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({game:'poll',config,share:true})});
  put('playroom:templates',[data.id,...local('playroom:templates',[]).filter(id=>id!==data.id)]);
  scope.querySelector('#poll-templates').open=true;
  await pollLobbyLoadTemplates(scope);showNotice('答項範本已儲存',button);
 } catch(error){showNotice(error.message||'無法儲存範本',button);}
 finally {button.disabled=false;}
}
function pollLobbyReplaceOptions(scope,mode,options) {
 pollLobbyCapture(scope);
 const current=pollLobbyDraft.options[pollLobbyDraft.mode];
 if(current.some(option=>option.label.trim()||String(option.point??'?').trim()!=='?')&&!confirm('套用後會取代目前答項，確定繼續嗎？'))return;
 pollLobbyDraft.mode=mode;
 pollLobbyDraft.options[mode]=options.map(option=>({label:String(option.label??''),point:String(option.point??'?')}));
 pollLobbyClearErrors(scope);pollLobbyOptionsView(scope);
 scope.querySelector('#poll-answer-editor').open=false;
 scope.querySelector('#poll-answer-editor>summary').focus();
}
function pollLobbyHistoryView(scope) {
 const history=pollLobbyDraft.history,body=scope.querySelector('#poll-recent-body');
 const row=item=>{
  const status={lobby:'等待開局',playing:'進行中',finished:'已結束'}[item.status]||'房間';
  const date=Number.isFinite(item.createdAt)?new Date(item.createdAt).toLocaleString('zh-TW'):'建立時間未知';
  return '<article class="poll-recent-item"><a href="'+withBasePath('/'+(item.status==='finished'?'results':'rooms')+'/'+encodeURIComponent(item.id))+'"><strong>房間 '+esc(item.id)+'</strong><span>'+status+' · '+esc(date)+'</span><b>'+(item.status==='finished'?'查看結果':'回到房間')+' →</b></a>'+(ownerToken(item.id)?'<details><summary>管理房間 '+esc(item.id)+'</summary><button type="button" class="danger" data-poll-action="delete-room" data-id="'+esc(item.id)+'">刪除房間</button></details>':'')+'</article>';
 };
 body.innerHTML=history.length?history.slice(0,5).map(row).join('')+(history.length>5?'<details class="poll-more-rooms"><summary>顯示其餘 '+(history.length-5)+' 個房間</summary>'+history.slice(5).map(row).join('')+'</details>':''):'<p class="muted">尚無最近房間。建立第一個投票房間，或透過朋友的連結加入。</p>';
 scope.querySelector('[data-poll-action="clear-recent"]').disabled=!history.length;
}
async function pollLobbyLoadHistory(scope) {
 const body=scope.querySelector('#poll-recent-body');
 body.innerHTML='<p class="muted" role="status">正在載入最近房間…</p>';
 try {
  const history=await api('/api/history?localIds='+local('playroom:rooms',[]).join(','));
  if(!scope.isConnected)return;
  pollLobbyDraft.history=history.filter(item=>item.game==='poll').sort((a,b)=>b.createdAt-a.createdAt);
  pollLobbyHistoryView(scope);
 } catch {
  if(scope.isConnected)body.innerHTML='<p class="poll-field-error" role="status">最近房間暫時無法載入，你仍可建立新房間。</p><button type="button" class="secondary" data-poll-action="reload-history">重新載入最近房間</button>';
 }
}
async function renderPollLobby() {
 pollLobbyDraft={mode:'standard',name:myName(),question:'',password:'',observer:false,options:{standard:pollLobbyBlankOptions(),scrum:pollLobbyBlankOptions()},templates:new Map(),history:[],creating:false};
 root.innerHTML='<main class="shell poll-lobby"><a href="/">← 平台大廳</a><header><p class="eyebrow">多人投票</p><h1>開一場投票，一起做決定</h1><p class="muted">一般投票或 Scrum 估點，先設定第一題，再邀請夥伴加入。</p></header><form id="poll-create-form" novalidate><section class="poll-lobby-panel"><h2><span>1</span> 選擇玩法</h2><div class="poll-mode-cards">'+[['standard','一般投票','聚餐、活動與團隊選擇，以票數掌握大家的偏好。'],['scrum','Scrum 估點','用 Story Point 評估工作，開牌後比較估點差異。']].map(([mode,title,description])=>'<label class="poll-mode-card" data-poll-mode="'+mode+'"><input type="radio" name="poll-mode-choice" value="'+mode+'" '+(mode==='standard'?'checked':'')+'><strong>'+title+'</strong><span>'+description+'</span><small class="poll-mode-check"></small></label>').join('')+'</div></section><section class="poll-lobby-panel"><h2><span>2</span> 設定第一題</h2><label class="poll-field-label" for="poll-question">題目</label><input id="poll-question" maxlength="160" aria-describedby="poll-question-error"><small id="poll-question-error" class="poll-field-error"></small><div class="poll-answer-heading"><h3>答項</h3><button id="poll-common-points" type="button" class="secondary" data-poll-action="common-points" hidden>套用常用點數</button></div><p class="muted">至少兩個答項；Scrum 點數可填數字或 ?。</p><div id="poll-answer-preview" class="poll-answer-preview" aria-label="目前答項" hidden></div><details id="poll-answer-editor" open><summary>編輯答項<span id="poll-answer-editor-count"></span></summary><div class="poll-answer-columns" aria-hidden="true"><span>#</span><span>答項名稱</span><span class="poll-answer-column-point" hidden>點數</span><span></span></div><div id="poll-lobby-options"></div><button type="button" class="secondary" data-poll-action="add">＋ 新增答項</button></details><details id="poll-templates"><summary>我的答項範本</summary><p class="muted">套用範本只更換玩法與答項，保留其他設定。</p><button type="button" class="secondary" data-poll-action="save-template">儲存目前答項</button><div id="poll-template-list"></div></details></section><section class="poll-lobby-panel"><h2><span>3</span> 你的身分</h2><label class="poll-field-label" for="poll-name">暱稱</label><input id="poll-name" maxlength="24" autocomplete="nickname" value="'+esc(pollLobbyDraft.name)+'" aria-describedby="poll-name-error"><small id="poll-name-error" class="poll-field-error"></small><fieldset class="poll-role-options"><legend>是否參與投票</legend><label><input type="radio" name="poll-role" value="voter" checked> 參與投票</label><label><input type="radio" name="poll-role" value="observer"> 只當觀察者</label></fieldset><p class="muted">局主即使只當觀察者，仍可強制開牌、開下一題及管理歷程。</p><details id="poll-password-settings"><summary>房間密碼（選填）</summary><label class="poll-field-label" for="poll-password">密碼</label><input id="poll-password" type="password" maxlength="128" autocomplete="new-password"><p class="muted">留白時，取得房間連結的人即可加入。</p></details></section><section class="poll-lobby-panel poll-create-panel" aria-label="建立房間"><p id="poll-create-summary"></p><p id="poll-create-error" class="poll-field-error" role="alert"></p><button id="poll-create" type="submit">建立投票房間</button><p class="muted">建立後即可複製房間連結，邀請夥伴加入。</p></section></form><section class="poll-lobby-panel poll-recent"><div class="poll-recent-heading"><h2>最近房間</h2><button type="button" class="secondary" data-poll-action="clear-recent" disabled>清除本機清單</button></div><p class="muted">只顯示這個瀏覽器曾建立或加入的投票房間；清除清單不會刪除房間。</p><div id="poll-recent-body"></div></section></main>';
 const scope=root.querySelector('.poll-lobby');pollLobbyOptionsView(scope);
 openChat({type:'game',id:'poll'});
 await Promise.allSettled([pollLobbyLoadTemplates(scope),pollLobbyLoadHistory(scope)]);
}
root.addEventListener('submit',event=>{if(event.target.id==='poll-create-form'){event.preventDefault();pollLobbyCreate(event.target.closest('.poll-lobby'))}});
root.addEventListener('input',event=>{const scope=event.target.closest('.poll-lobby');if(scope){pollLobbyCapture(scope);pollLobbySummary(scope);if(event.target.getAttribute('aria-invalid')){event.target.removeAttribute('aria-invalid');document.getElementById(event.target.getAttribute('aria-describedby')).textContent=''}}});
root.addEventListener('change',event=>{
 const scope=event.target.closest('.poll-lobby');if(!scope)return;
 pollLobbyCapture(scope);
 if(event.target.name==='poll-mode-choice'){pollLobbyDraft.mode=event.target.value;pollLobbyClearErrors(scope);pollLobbyOptionsView(scope);scope.querySelector('#poll-answer-editor').open=!pollLobbyDraft.options[pollLobbyDraft.mode].every(option=>option.label.trim())}
 pollLobbySummary(scope);
});
root.addEventListener('click',async event=>{
 const button=event.target.closest('[data-poll-action]'),scope=button?.closest('.poll-lobby');
 if(!scope||button.disabled)return;
 const action=button.dataset.pollAction;
 if(action==='add'||action==='remove'){
  pollLobbyCapture(scope);const options=pollLobbyDraft.options[pollLobbyDraft.mode];
  if(action==='add')options.push({label:'',point:'?'});else if(options.length>2)options.splice(Number(button.dataset.index),1);
  pollLobbyOptionsView(scope);
  const index=action==='add'?options.length-1:Math.min(Number(button.dataset.index),options.length-1);
  scope.querySelector('#poll-answer-'+index)?.focus();
 }
 if(action==='common-points')pollLobbyReplaceOptions(scope,'scrum',[0,1,2,3,5,8,13,21,'?'].map(point=>({label:String(point),point})));
 if(action==='save-template')await pollLobbySaveTemplate(scope,button);
 if(action==='reload-templates')await pollLobbyLoadTemplates(scope);
 if(action==='reload-history')await pollLobbyLoadHistory(scope);
 if(action==='apply-template'){
  const item=pollLobbyDraft.templates.get(button.dataset.id);
  if(item&&Array.isArray(item.config?.options)&&item.config.options.length>=2)pollLobbyReplaceOptions(scope,item.config.mode==='scrum'?'scrum':'standard',item.config.options);
  else showNotice('範本答項不完整，請選擇其他範本。',button);
 }
 if(action==='delete-template'&&confirm('確定刪除此答項範本嗎？此操作無法復原。')){
  button.disabled=true;
  try {await api('/api/templates/'+encodeURIComponent(button.dataset.id),{method:'DELETE'});put('playroom:templates',local('playroom:templates',[]).filter(id=>id!==button.dataset.id));await pollLobbyLoadTemplates(scope);showNotice('答項範本已刪除',scope.querySelector('#poll-templates summary'));}
  catch(error){showNotice(error.message||'無法刪除範本',button);button.disabled=false;}
 }
 if(action==='clear-recent'){
  try {const ids=new Set(pollLobbyDraft.history.map(item=>item.id));put('playroom:rooms',local('playroom:rooms',[]).filter(id=>!ids.has(id)));pollLobbyDraft.history=[];pollLobbyHistoryView(scope);showNotice('已清除本機清單，房間仍保留。',button);}
  catch {showNotice('無法清除清單，請檢查瀏覽器儲存權限。',button);}
 }
 if(action==='delete-room'&&confirm('確定刪除此房間與全部結果、事件、聊天紀錄嗎？此操作無法復原。')){
  button.disabled=true;
  try {await api('/api/rooms/'+encodeURIComponent(button.dataset.id),{method:'DELETE',headers:{'x-room-owner':ownerToken(button.dataset.id)}});forgetRoom(button.dataset.id);pollLobbyDraft.history=pollLobbyDraft.history.filter(item=>item.id!==button.dataset.id);pollLobbyHistoryView(scope);showNotice('房間已刪除',scope.querySelector('.poll-recent h2'));}
  catch(error){showNotice(error.message||'無法刪除房間',button);button.disabled=false;}
 }
});
`;

export const pollLobbyStyles = String.raw`
.poll-lobby{font-family:system-ui,sans-serif;line-height:1.6;max-width:920px}
.poll-lobby>header{margin:28px 0}
.poll-lobby>header h1{font-family:inherit;font-size:clamp(25px,4vw,34px);letter-spacing:normal;line-height:1.4;text-shadow:none;overflow-wrap:anywhere}
.poll-lobby .eyebrow{font-size:14px;color:#a7f4d9}
.poll-lobby .muted{font-size:14px;line-height:1.7}
.poll-lobby p{margin:10px 0 16px}
.poll-lobby form{display:grid;gap:20px}
.poll-lobby-panel{padding:28px;border:1px solid #456e64;background:#102523;box-shadow:3px 3px #030b0a;min-width:0}
.poll-lobby h2{font-size:20px;line-height:1.4;margin:0 0 20px;color:#eaf7f4}
.poll-lobby h2>span{display:inline-grid;place-items:center;width:28px;height:28px;margin-right:6px;border:1px solid #699d93;color:#ffc85a;font-size:16px}
.poll-lobby h3{font-size:17px;margin:0;color:#eaf7f4}
.poll-lobby h4{font-size:16px;margin:0;color:#eaf7f4}
.poll-lobby button,.poll-lobby input,.poll-lobby select{font-family:inherit;font-size:16px;min-height:44px;max-width:100%}
.poll-lobby button{white-space:normal;overflow-wrap:anywhere;line-height:1.4}
.poll-lobby input:not([type="radio"]){width:100%;margin:0;padding:10px 12px}
.poll-lobby .poll-field-label{display:block;font-size:15px;font-weight:700;margin:0 0 8px}
.poll-lobby [aria-invalid="true"]{border-color:#ff9da6;outline-color:#ff9da6}
.poll-lobby .poll-field-error{display:block;font-size:14px;color:#ffbac3;margin-top:6px;overflow-wrap:anywhere}
.poll-lobby .poll-field-error:empty{display:none}
.poll-lobby .poll-field-error:not(:empty){margin-bottom:12px}
.poll-mode-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.poll-mode-card{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr);align-items:start;gap:10px;padding:20px;background:#0b1d1a;border:1px solid #699d93;cursor:pointer}
.poll-mode-card.selected{border-color:#ffd36d;background:#302a12;box-shadow:inset 0 0 0 1px #ffd36d}
.poll-lobby .poll-mode-card input,.poll-lobby .poll-role-options input{appearance:auto;accent-color:#ffc85a;min-height:20px;width:20px;height:20px;margin:3px 0 0;flex:none;box-shadow:none}
.poll-mode-card strong{font-size:19px;line-height:1.4;color:#eaf7f4}
.poll-mode-card>span,.poll-mode-card>small{grid-column:2;font-size:14px;color:#c0d8d3}
.poll-mode-card>small{min-height:23px;color:#fff1b2;font-weight:700}
.poll-mode-card:focus-within{outline:3px solid #ffc85a;outline-offset:4px}
.poll-lobby .poll-answer-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-top:28px}
#poll-answer-editor{margin-top:12px}
.poll-lobby #poll-lobby-options{display:grid;gap:6px;margin-bottom:12px}
.poll-lobby .poll-lobby-answer,.poll-answer-columns{display:grid;grid-template-columns:24px minmax(0,1fr) 44px;align-items:start;gap:8px;padding:0;border:0}
.poll-lobby .poll-lobby-answer:has(.poll-point-field),.poll-answer-columns.with-points{grid-template-columns:24px minmax(0,1fr) 100px 44px}
.poll-answer-columns{font-size:13px;color:#c0d8d3;margin-bottom:6px}
.poll-lobby-answer>div{min-width:0}
.poll-lobby-answer label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.poll-lobby .poll-lobby-answer input{padding:8px}
.poll-answer-number{align-self:start;padding-top:10px;color:#a7c7c0;font-size:14px;text-align:center;font-variant-numeric:tabular-nums}
.poll-lobby .poll-lobby-answer .poll-remove{width:44px;min-width:44px;margin:0;padding:0;font-size:22px;box-shadow:none}
.poll-answer-preview{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 8px}
.poll-answer-preview>span{border:1px solid #699d93;background:#0b1d1a;padding:5px 10px;font-size:16px;overflow-wrap:anywhere;max-width:100%}
.poll-answer-preview b{color:#ffe19a}
.poll-lobby-panel:has(#poll-answer-editor[open]) .poll-answer-preview{display:none}
.poll-lobby details{min-width:0}
.poll-lobby summary{min-height:44px;align-content:center;cursor:pointer;font-size:16px;font-weight:700;overflow-wrap:anywhere}
.poll-lobby details[open]>summary{margin-bottom:16px}
.poll-lobby button:focus-visible,.poll-lobby summary:focus-visible,.poll-lobby a:focus-visible{outline:3px solid #ffc85a;outline-offset:4px}
.poll-lobby #poll-templates{border-top:1px solid #456e64;margin-top:24px;padding-top:16px}
.poll-template-item{margin-top:16px;padding:20px;background:#0b1d1a;border:1px solid #34564f;overflow-wrap:anywhere}
.poll-template-item p{font-size:15px;margin:10px 0}
.poll-template-item>small{display:block;color:#a7c7c0;font-size:12px}
.poll-inline-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.poll-role-options{display:flex;flex-wrap:wrap;gap:12px 28px;padding:0;border:0;margin:24px 0 12px;min-width:0}
.poll-role-options legend{font-size:15px;font-weight:700;margin-bottom:12px}
.poll-role-options label{display:flex;align-items:center;gap:8px;min-height:44px;font-size:16px;cursor:pointer}
.poll-lobby #poll-password-settings{border-top:1px solid #456e64;margin-top:24px;padding-top:16px}
.poll-lobby .poll-create-panel{border-color:#73d8c2}
.poll-lobby #poll-create{width:100%;font-size:18px;min-height:52px;margin:8px 0}
.poll-lobby #poll-create-summary{font-size:16px;font-weight:700;color:#ffe19a;margin-top:0}
.poll-lobby .poll-create-panel>.muted{margin-bottom:0}
.poll-lobby .poll-recent{margin-top:32px}
.poll-recent-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.poll-lobby .poll-recent-heading h2{margin:0}
.poll-recent-item{border-top:1px solid #456e64;padding:18px 0}
.poll-recent-item>a{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 20px;color:#eaf7f4;text-decoration:none;overflow-wrap:anywhere}
.poll-recent-item>a:hover strong,.poll-recent-item>a:hover b{color:#ffc85a}
.poll-recent-item>a strong{font-size:17px}
.poll-recent-item>a span{grid-column:1;font-size:14px;color:#c0d8d3}
.poll-recent-item>a b{grid-column:2;grid-row:1 / span 2;align-self:center;font-size:15px;color:#a7f4d9}
.poll-recent-item>details{margin-top:10px}
.poll-recent-item>details summary{font-size:13px;color:#c0d8d3}
.poll-more-rooms{border-top:1px solid #456e64;padding-top:12px}
.poll-lobby [hidden]{display:none!important}
@media(max-width:620px){
 .poll-lobby-panel{padding:20px}
 .poll-mode-cards{grid-template-columns:minmax(0,1fr);gap:12px}
 .poll-mode-card{padding:16px}
 .poll-mode-card>small:empty{min-height:0}
 .poll-lobby .poll-lobby-answer,.poll-answer-columns{grid-template-columns:18px minmax(0,1fr) 44px;gap:6px}
 .poll-lobby .poll-lobby-answer:has(.poll-point-field),.poll-answer-columns.with-points{grid-template-columns:18px minmax(0,1fr) 68px 44px}
 .poll-recent-item>a{grid-template-columns:minmax(0,1fr)}
 .poll-recent-item>a b{grid-column:1;grid-row:auto;margin-top:4px}
 .poll-inline-actions button{flex:1 1 130px}
}
@media(prefers-reduced-motion:reduce){.poll-lobby *{animation:none!important;transition:none!important}}
`;
