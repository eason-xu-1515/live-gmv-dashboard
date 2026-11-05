'use strict';
(() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal:true});
  const bytes = value => {
    if(typeof value!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length%4) throw new Error('密文格式异常');
    return Uint8Array.from(atob(value), char=>char.charCodeAt(0));
  };
  function validate(envelope){
    if(!envelope || envelope.version!==1 || envelope.kdf!=='PBKDF2-SHA256' || envelope.iterations!==600000 || envelope.cipher!=='AES-256-GCM') throw new Error('加密版本不支持');
    if(bytes(envelope.salt).length!==32 || bytes(envelope.iv).length!==12 || bytes(envelope.ciphertext).length<16 || envelope.ciphertext.length>2000000) throw new Error('密文长度异常');
  }
  async function derive(envelope,password){
    validate(envelope);
    const source=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:bytes(envelope.salt),iterations:600000},source,{name:'AES-GCM',length:256},false,['decrypt']);
  }
  function validDay(day){
    if(typeof day!=='string' || !/^\d{8}$/.test(day)) return false;
    const date=new Date(`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6)}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10).replaceAll('-','')===day;
  }
  async function decrypt(envelope,key,username){
    validate(envelope);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),tagLength:128,additionalData:encoder.encode(`live-gmv-pages:1:${username}`)},key,bytes(envelope.ciphertext));
    const payload=JSON.parse(decoder.decode(plain));
    if(payload?.kind==='catalog'){
      if(payload.version!==1 || !payload.days || typeof payload.days!=='object' || Array.isArray(payload.days) || !validDay(payload.business_day) || payload.period?.start!=='20261031' || payload.period?.end!=='20261118') throw new Error('目录结构异常');
      for(const [day,item] of Object.entries(payload.days)){
        if(!validDay(day) || day>=payload.business_day || !item || !['snapshot','pending','full_window','missing'].includes(item.status) || item.path && (item.path!==`history/${day}.${item.revision}.enc.json` || !/^[a-f0-9]{32}$/.test(item.revision) || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('目录路径异常');
      }
      return payload;
    }
    if(payload?.kind==='history'){
      const r=payload.record,p=r?.payload;
      if(payload.version!==1 || r?.version!==1 || !validDay(r.business_day) || !/^[a-f0-9]{32}$/.test(r.revision) || r.business_day!==p?.snapshot?.business_day || p.targets?.business_day!==r.business_day || p.snapshot.schema_version!==2 || 'aggregate_rows' in p.snapshot || !/^[a-f0-9]{64}$/.test(r.checksum) || !['snapshot','full_window'].includes(r.status) || !r.metric_status || Object.values(r.metric_status).some(s=>!['snapshot','pending','full_window','missing'].includes(s))) throw new Error('归档结构异常');
      if(r.target_correction){
        const c=r.target_correction,v=p.investment?.countries?.IL?.nn;
        if(r.target_origin!=='explicit_target_correction' || r.business_day!=='20261101' || c.business_day!==r.business_day || c.country!=='IL' || c.metric!=='nn' || c.previous_rate_pct!==24.5 || c.rate_pct!==48 || c.source!=='11月追踪表' || c.column!=='AP' || !/^[a-f0-9]{32}$/.test(c.previous_revision) || !/^[a-f0-9]{64}$/.test(c.fingerprint) || v?.target_rate_pct!==48 || v.target_gmv!==c.target_gmv || p.targets.countries.IL.nn!==c.target_gmv) throw new Error('目标更正结构异常');
      }else if(r.target_origin==='explicit_target_correction') throw new Error('目标更正证明缺失');
      if(r.investment_correction){
        const c=r.investment_correction;
        if(c.business_day!==r.business_day || c.kind!=='linked_totals_v1' || !/^[a-f0-9]{32}$/.test(c.previous_revision) || !/^[a-f0-9]{32}$/.test(c.component_revision) || !Number.isFinite(Date.parse(c.corrected_at)) || p.investment?.linked_totals!==true) throw new Error('投资联动更正证明无效');
      }
      return payload;
    }
    if(!payload?.snapshot || payload.snapshot.schema_version!==2 || 'aggregate_rows' in payload.snapshot || payload.targets?.business_day!==payload.snapshot.business_day) throw new Error('快照结构异常');
    return payload;
  }
  function expired(wallDeadline,monotonicDeadline){
    return Date.now()>=wallDeadline || performance.now()>=monotonicDeadline;
  }
  if(typeof module!=='undefined' && module.exports) module.exports={derive,decrypt,validate,expired};
  if(typeof window==='undefined' || !document.getElementById('pages-gate')) return;
  const $=id=>document.getElementById(id), TTL=8*3600*1000;
  const bucRequired=document.querySelector('meta[name="aone-buc"]')?.content==='required';
  const bucMessage='集团 BUC 登录已失效，请刷新页面重新登录';
  let key=null, username='', salt='', expires=0, wallExpires=0, timer=null, generation=0, cached=null, lastCipher='';
  const historicalCache=new Map();
  function lock(message=''){
    generation++;key=null;username='';salt='';expires=0;wallExpires=0;cached=null;lastCipher='';historicalCache.clear();clearTimeout(timer);
    $('pages-password').value='';$('pages-dashboard').hidden=true;$('pages-gate').hidden=false;$('pages-error').textContent=message;
    window.dispatchEvent(new Event('live-locked'));
  }
  function locked(){
    if(key && expired(wallExpires,expires)) lock('解密已超过8小时，请重新输入口令');
    return !key;
  }
  async function verifyBuc(){
    if(!bucRequired) return;
    try{
      const response=await fetch('/_pages/buc-user',{cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const user=await response.json();
      if(!user || typeof user.empId!=='string' || !user.empId) throw new Error();
    }catch(error){lock(bucMessage);throw new Error(bucMessage);}
  }
  async function fetchEnvelope(path='snapshot.enc.json',digest=null,optional=false){
    if(!['snapshot.enc.json','catalog.enc.json'].includes(path) && !/^history\/\d{8}\.[a-f0-9]{32}\.enc\.json$/.test(path)) throw new Error('不允许的密文路径');
    const url=new URL(path,document.baseURI);
    if(url.origin!==location.origin) throw new Error('密文必须来自同源地址');
    url.searchParams.set('v',String(Date.now()));
    await verifyBuc();
    const response=await fetch(url,{cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(optional && response.status===404) return null;
    if(!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('快照暂时不可用');
    const text=await response.text();if(text.length>2000000) throw new Error('快照过大');
    if(digest){
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
      if(hash!==digest) throw new Error('密文版本不一致');
    }
    const envelope=JSON.parse(text);validate(envelope);return envelope;
  }
  async function readArtifact(path,digest=null,optional=false){
    if(locked()) return null;
    const version=generation,cacheKey=`${path}:${digest}`;
    if(digest && historicalCache.has(cacheKey)) return historicalCache.get(cacheKey);
    const envelope=await fetchEnvelope(path,digest,optional);
    if(!envelope || version!==generation || locked()) return null;
    if(envelope.salt!==salt) throw new Error('共享口令版本不一致');
    const data=await decrypt(envelope,key,username);
    if(version!==generation || locked()) return null;
    if(digest){
      historicalCache.set(cacheKey,data);
      if(historicalCache.size>60) historicalCache.delete(historicalCache.keys().next().value);
    }
    return data;
  }
  window.liveDataSource={locked,lock,
    async readCatalog(){return readArtifact('catalog.enc.json',null,true);},
    async readHistory(day,item){
      if(!item?.path || !validDay(day) || item.path!==`history/${day}.${item.revision}.enc.json` || !/^[a-f0-9]{32}$/.test(item.revision) || !/^[a-f0-9]{64}$/.test(item.sha256)) return null;
      const value=await readArtifact(item.path,item.sha256);
      if(!value) return null;
      const r=value.record;
      if(value.kind!=='history' || r.business_day!==day || r.revision!==item.revision) throw new Error('历史日期或修订不一致');
      if(r.status!==item.status || JSON.stringify(r.metric_status)!==JSON.stringify(item.metric_status)) throw new Error('历史状态与目录不一致');
      return {...r.payload,history_view:{business_day:day,revision:r.revision,status:r.status,captured_at:r.captured_at,metric_status:r.metric_status,target_origin:r.target_origin,...(r.target_correction ? {target_correction:r.target_correction} : {}),...(r.investment_correction ? {investment_correction:r.investment_correction} : {})}};
    },async read(){
    if(locked()) return null;
    const version=generation;
    const envelope=await fetchEnvelope();
    if(version!==generation || locked()) return null;
    if(envelope.salt!==salt) throw new Error('共享口令已轮换，请退出后重新解密');
    if(envelope.ciphertext===lastCipher && cached) return cached;
    const data=await decrypt(envelope,key,username);
    if(version!==generation || locked()) return null;
    cached=data;lastCipher=envelope.ciphertext;return data;
  }};
  $('pages-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('pages-submit'), version=++generation;
    button.disabled=true;$('pages-error').textContent='正在本地解密…';
    let password=$('pages-password').value;
    const submittedUser=$('pages-username').value;
    $('pages-password').value='';
    try{
      if(!window.isSecureContext || !crypto.subtle) throw new Error('需要HTTPS与支持Web Crypto的浏览器');
      const envelope=await fetchEnvelope();const candidate=await derive(envelope,password);password='';
      const data=await decrypt(envelope,candidate,submittedUser);
      if(version!==generation) return;
      key=candidate;username=submittedUser;salt=envelope.salt;cached=data;lastCipher=envelope.ciphertext;
      expires=performance.now()+TTL;wallExpires=Date.now()+TTL;clearTimeout(timer);timer=setTimeout(()=>lock('解密已过期，请重新输入口令'),TTL);
      $('pages-error').textContent='';$('pages-gate').hidden=true;$('pages-dashboard').hidden=false;
      window.dispatchEvent(new Event('live-unlocked'));
    }catch(error){
      if(version===generation) $('pages-error').textContent=error.message===bucMessage ? bucMessage : '账号或共享口令不正确，或快照暂时不可用；不会发送你的口令。';
    }finally{password='';button.disabled=false;$('pages-password').value='';}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) locked();});
  window.addEventListener('pagehide',()=>lock());
})();
