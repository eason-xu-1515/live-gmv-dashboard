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
  async function decrypt(envelope,key,username){
    validate(envelope);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),tagLength:128,additionalData:encoder.encode(`live-gmv-pages:1:${username}`)},key,bytes(envelope.ciphertext));
    const payload=JSON.parse(decoder.decode(plain));
    if(!payload?.snapshot || payload.snapshot.schema_version!==2 || 'aggregate_rows' in payload.snapshot || payload.targets?.business_day!==payload.snapshot.business_day) throw new Error('快照结构异常');
    return payload;
  }
  function expired(wallDeadline,monotonicDeadline){
    return Date.now()>=wallDeadline || performance.now()>=monotonicDeadline;
  }
  if(typeof module!=='undefined' && module.exports) module.exports={derive,decrypt,validate,expired};
  if(typeof window==='undefined' || !document.getElementById('pages-gate')) return;
  const $=id=>document.getElementById(id), TTL=8*3600*1000;
  let key=null, username='', salt='', expires=0, wallExpires=0, timer=null, generation=0, cached=null, lastCipher='';
  function lock(message=''){
    generation++;key=null;username='';salt='';expires=0;wallExpires=0;cached=null;lastCipher='';clearTimeout(timer);
    $('pages-password').value='';$('pages-dashboard').hidden=true;$('pages-gate').hidden=false;$('pages-error').textContent=message;
    window.dispatchEvent(new Event('live-locked'));
  }
  function locked(){
    if(key && expired(wallExpires,expires)) lock('解密已超过8小时，请重新输入口令');
    return !key;
  }
  async function fetchEnvelope(){
    const url=new URL('snapshot.enc.json',document.baseURI);url.searchParams.set('v',String(Date.now()));
    const response=await fetch(url,{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error('快照暂时不可用');
    const text=await response.text();if(text.length>2000000) throw new Error('快照过大');
    const envelope=JSON.parse(text);validate(envelope);return envelope;
  }
  window.liveDataSource={locked,lock,async read(){
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
      if(version===generation) $('pages-error').textContent='账号或共享口令不正确，或快照暂时不可用；不会发送你的口令。';
    }finally{password='';button.disabled=false;$('pages-password').value='';}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) locked();});
  window.addEventListener('pagehide',()=>lock());
})();
