'use strict';
const metrics = [{key:'total',label:'GMV'},{key:'nn',label:'NN GMV'},{key:'sd',label:'SD GMV'}];
const kpis = [
  {key:'total',label:'GMV',format:'money',tag:'TOTAL'},
  {key:'total_rate',label:'达成率',format:'percent',tag:'TARGET'},
  {key:'nn',label:'NN GMV',format:'money',tag:'NN'},
  {key:'nn_rate',label:'NN达成率',format:'percent',tag:'TARGET'},
  {key:'sd',label:'SD GMV',format:'money',tag:'SD'},
  {key:'sd_rate',label:'SD达成率',format:'percent',tag:'TARGET'},
  {key:'dac',label:'DAC',format:'integer',tag:'CUSTOMERS'}
];
const investmentKeys = [
  {key:'total',label:'总经营TR',note:'跨源近实时 · 非严格同小时、非财务全量'},
  {key:'nn',label:'NN费率',note:'金本位花费 ÷ 同源 tax_gmv · 小时截止未知'},
  {key:'sd_brand',label:'SD品牌TR',note:'品牌常规花费 ÷ 同小时SD业务GMV'},
  {key:'sd_nonbrand',label:'SD非品牌TR',note:'非品牌常规花费 ÷ 同小时SD业务GMV'},
  {key:'incremental',label:'整体增投TR',note:'全部增投资金花费 ÷ 同小时大盘业务GMV'}
];
const investmentReasons = {source_failed:'投资源待更新',source_timeout:'投资源查询超时',source_invalid:'投资源校验未通过',target_missing:'目标缺项，GAP留空',target_scope:'目标资金范围待核验',denominator_missing:'对应GMV缺失或为零',hour_missing:'业务GMV小时缺失',no_safe_hour:'暂无安全截止小时',unknown_fund:'含未识别资金实际',unbudgeted:'含预算外实际',nn_hour_unknown:'NN小时截止未知',cross_source:'跨源近实时',expired:'原快照已过期，等待更新',target_invalid:'目标版本待核验',day_changed:'业务日已切换',dst_watermark:'重复小时水位待核验'};
const countries = [['US','美国'],['BR','巴西'],['MX','墨西哥'],['CL','智利'],['KR','韩国'],['JP','日本'],['IL','以色列'],['GCC','GCC'],['ONE','一人一国']];
const oneCountryIso = 'COL CHE NOR PER THA SGP PAK ARG MYS SRB REU HKG LKA AGO ISL ALB MTQ VNM CRI BGD SLV PHL GLP MUS PRI GUF TZA MOZ SYC KHM MKD PYF ZMB BOL CPV BIH PRY UGA MDV MNE NIC BRN NCL CIV DOM GTM TWN SEN MDG BWA BFA ZWE URY TUN JOR MWI RWA MMR GIN HND PNG ABW GNQ FRO NPL NAM'.split(' ');
const iso = {USA:'US',BRA:'BR',MEX:'MX',CHL:'CL',KOR:'KR',JPN:'JP',ISR:'IL',SAU:'GCC',ARE:'GCC',QAT:'GCC',KWT:'GCC',BHR:'GCC',OMN:'GCC',...Object.fromEntries(oneCountryIso.map(code=>[code,'ONE']))};
const centers = {US:[-100,39,-18,-37],BR:[-52,-12,-10,45],MX:[-102,23,-66,26],CL:[-71,-34,-38,39],KR:[128,36,-17,-42],JP:[138,37,40,18],IL:[35,31,-83,-25],GCC:[51,24,27,42]};
const colors = {total:'#32a8ff',nn:'#11e3de',sd:'#b690ff'};
const money = new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const integer = new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
const timeFormat = new Intl.DateTimeFormat('zh-CN',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const hourFormat = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'2-digit',hourCycle:'h23'});
const dateFormat = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $ = id => document.getElementById(id);
let selectedCountry = 'ALL', selected = 'total', trendMode = 'hourly', payload = null;
let nextPoll = Date.now()+60000, offset = 0, fetchRunning = false, networkError = false, mapLoaded = false;
let responseGeneration = 0, suspended = false;

function text(id,value){$(id).textContent=value;}
function numeric(value){return typeof value === 'number' && Number.isFinite(value);}
function formatted(value,format='money'){return numeric(value) ? (format === 'integer' ? integer : money).format(value) : '—';}
function paidTime(value){return value ? timeFormat.format(new Date(value)) : '—';}
function compact(value){if(!numeric(value)) return '—'; return value>=1e6 ? `${(value/1e6).toFixed(2)}M` : value>=1e3 ? `${(value/1e3).toFixed(1)}K` : value.toFixed(0);}
function regionName(){return selectedCountry === 'ALL' ? '美亚合计（八国＋一人一国）' : selectedCountry === 'ONE' ? '一人一国（66国）' : countries.find(c=>c[0]===selectedCountry)[1];}
function regionData(code){return payload?.snapshot?.countries?.find(c=>c.code===code);}
function currentMetrics(){return selectedCountry === 'ALL' ? payload?.snapshot?.totals : regionData(selectedCountry)?.metrics;}
function currentTargets(){return selectedCountry === 'ALL' ? payload?.targets?.totals : payload?.targets?.countries?.[selectedCountry];}
function rate(actual,target){return numeric(actual) && numeric(target) && target>0 ? actual/target*100 : null;}
function rateText(value,signed=false){
  if(!numeric(value)) return '—';
  const prefix=signed && value>0 ? '+' : signed && value<0 ? '−' : '';
  const amount=Math.abs(value);
  return prefix+(amount>0 && amount<0.01 ? '<0.01' : money.format(amount));
}
function investmentCountries(){return payload?.investment?.version===1 ? countries : countries.filter(([code])=>code!=='ONE');}
function investmentRegionName(){
  if(selectedCountry!=='ALL') return regionName();
  return payload?.investment?.version===1 ? '旧版投资合计（八国＋一人一国）' : '投资合计（核心8国，不含一人一国）';
}
function investmentData(){
  const block=payload?.investment;
  if(![1,2].includes(block?.version) || block.business_day!==payload?.snapshot?.business_day) return null;
  return selectedCountry==='ALL' ? block.totals : block.countries?.[selectedCountry];
}
function investmentExpired(value){
  const now=Date.now()+offset;
  return !value?.source_success_at || !Number.isFinite(Date.parse(value.source_success_at)) ||
    now-Date.parse(value.source_success_at)>1800000 || Date.parse(value.source_success_at)-now>300000 ||
    payload?.investment?.business_day!==dateFormat.format(new Date(now)).replaceAll('-','');
}
function renderInvestment(){
  text('investment-region',investmentRegionName());
  const items=investmentData();
  investmentKeys.forEach(({key,note})=>{
    const card=$(`investment-${key}`),v=items?.[key],expired=v?.source_success_at && investmentExpired(v);
    const usable=v?.source_success_at && !expired && ['ok','stale'].includes(v.status) && numeric(v.rate_pct);
    card.dataset.status=usable ? v.status : 'waiting';
    card.querySelector('.investment-actual').textContent=usable ? `${rateText(v.rate_pct)}%` : '—';
    card.querySelector('.investment-target').textContent=`目标 ${numeric(v?.target_rate_pct) ? rateText(v.target_rate_pct)+'%' : '—'}`;
    const gap=usable && numeric(v.gap_pp) ? v.gap_pp : null;
    card.querySelector('.investment-gap').textContent=numeric(gap) ? `${rateText(gap,true)} pp · ${gap>0 ? '高于目标' : gap<0 ? '低于目标' : '与目标一致'}` : 'GAP —';
    card.querySelector('.investment-basis').textContent=usable ? `花费 $${formatted(v.spend)} / 对应GMV $${formatted(v.gmv)}` : '花费 / 对应GMV 待更新';
    card.querySelector('.investment-time').textContent=v?.source_success_at ? `${v.status==='stale' ? '原来源成功' : '来源成功'} ${paidTime(v.source_success_at)}（美西） · ${Number.isInteger(v.cutoff_hour) ? '同小时截取至 '+String(v.cutoff_hour).padStart(2,'0')+':00' : '小时截止未知'}` : '来源时间待更新';
    const reasons=(v?.reason_codes || []).map(reason=>investmentReasons[reason]).filter(Boolean);
    if(expired) reasons.push('原快照已过期，等待更新');
    if(v?.status==='stale' && !expired) reasons.unshift('待更新：完整保留原费率、分母与目标');
    if(!items) reasons.push('投资数据待接入');
    if(selectedCountry==='ALL' && !numeric(v?.target_rate_pct) && payload?.investment){
      const missing=investmentCountries().filter(([c])=>!numeric(payload.investment.countries?.[c]?.[key]?.target_rate_pct)).map(([,name])=>name);
      if(missing.length) reasons.push('合计目标缺项：'+missing.join('、'));
    }
    card.querySelector('.investment-status').textContent=[...new Set(reasons)].join(' · ') || '同日快照';
    card.querySelector('.investment-definition').textContent=note;
  });
  const sources=payload?.investment?.sources;
  text('investment-sources',sources ? ['nn','marketing'].map(key=>{
    const s=sources[key];return `${key==='nn' ? 'NN' : '营销'}查询 ${paidTime(s?.query_started_at)}–${paidTime(s?.query_finished_at)}（美西，查询时间不是数据水位） · ${s?.status==='ok' ? '本轮来源成功' : '本轮来源待更新'}`;
  }).join('；') : '投资数据待接入；缺目标与未取得的数据均留空。');
}
function clearSensitive(){
  responseGeneration++;payload=null;offset=0;networkError=false;render(false);
}
function half(char,position,extra=''){
  const node=document.createElement('span');node.className=`half ${position} ${extra}`;
  const glyph=document.createElement('span');glyph.className='glyph';glyph.textContent=char;node.append(glyph);return node;
}
function digit(char){const node=document.createElement('span');node.className='digit';node.dataset.char=char;node.append(half(char,'top'),half(char,'bottom'));return node;}
function animateDigit(cell,prior,char,animate){
  if(!animate || reducedMotion.matches || prior===char) return;
  const upper=half(/\d/.test(prior || '') ? prior : ' ','top','flip-top'),lower=half(char,'bottom','flip-bottom');
  cell.append(upper,lower);setTimeout(()=>{upper.remove();lower.remove();},700);
}
function flipNumber(node,value,animate=true){
  const format=node.dataset.format || 'money',next=formatted(value,format),old=node.dataset.value;
  if(next===old) return;
  node.setAttribute('aria-label',next==='—' ? '数据待更新' : `${next} ${format==='money' ? '美元' : format==='percent' ? '%' : '人'}`);
  node.dataset.value=next;
  if(next==='—'){const placeholder=document.createElement('span');placeholder.className='placeholder';placeholder.textContent='—';node.replaceChildren(placeholder);return;}
  if(!old || old==='—' || old.length!==next.length){
    node.replaceChildren(...Array.from(next,(char,index)=>{
      if(/\d/.test(char)){const cell=digit(char);if(old && old!=='—') animateDigit(cell,old[index+old.length-next.length],char,animate);return cell;}
      const punctuation=document.createElement('span');punctuation.className='punct';punctuation.textContent=char;return punctuation;
    }));return;
  }
  Array.from(next).forEach((char,index)=>{
    const cell=node.children[index];if(!/\d/.test(char)){cell.textContent=char;return;}
    const prior=cell.dataset.char;if(prior===char) return;
    cell.dataset.char=char;cell.replaceChildren(half(char,'top'),half(char,'bottom'));animateDigit(cell,prior,char,animate);
  });
}
function fitNumbers(){
  document.querySelectorAll('.kpi-value .number').forEach(node=>{
    node.style.fontSize='';const row=node.parentElement,currency=row.querySelector('.currency');
    const available=row.clientWidth-currency.getBoundingClientRect().width-parseFloat(getComputedStyle(row).gap);
    for(let i=0;i<3 && node.scrollWidth>available;i++){
      const size=parseFloat(getComputedStyle(node).fontSize);node.style.fontSize=`${Math.max(8,Math.floor(size*(available-1)/node.scrollWidth*10)/10)}px`;
    }
  });
}
function selectCountry(code){selectedCountry=code;render(false);}
function initialize(){
  kpis.forEach(kpi=>{
    const card=document.createElement('article');card.className='total-card';card.id=`kpi-${kpi.key}`;
    card.innerHTML=`<div class="total-head"><span>${kpi.label}</span><small>${kpi.tag}</small></div><div class="kpi-value"><span class="currency${kpi.format==='money' ? '' : ' suffix'}">${kpi.format==='money' ? '$' : kpi.format==='percent' ? '%' : '人'}</span><div class="number" id="total-${kpi.key}" data-format="${kpi.format}" role="img"></div></div><div class="total-foot"></div><div class="rate-bar"><span></span></div>`;
    $('totals').append(card);
  });
  investmentKeys.forEach(({key,label})=>{
    const card=document.createElement('article');card.className='investment-card';card.id=`investment-${key}`;
    card.innerHTML=`<h3>${label}</h3><div class="investment-actual">—</div><div class="investment-target">目标 —</div><div class="investment-gap">GAP —</div><p class="investment-basis"></p><p class="investment-time"></p><p class="investment-status"></p><p class="investment-definition"></p>`;
    $('investment-cards').append(card);
  });
  [['ALL','美亚合计'],...countries].forEach(([code,name])=>{
    const button=document.createElement('button');button.textContent=name;button.dataset.country=code;
    button.addEventListener('click',()=>selectCountry(code));$('country-tabs').append(button);
  });
  countries.forEach(([code,name])=>{
    const button=document.createElement('button');button.dataset.market=code;
    const label=document.createElement('span');label.textContent=code==='ONE' ? `${name}（66国）` : `${name} ${code==='GCC' ? '' : code}`;
    const value=document.createElement('b');value.textContent='—';button.append(label,value);
    button.addEventListener('click',()=>selectCountry(code));$('market-list').append(button);
  });
  metrics.forEach(metric=>{
    const button=document.createElement('button');button.textContent=metric.label;button.dataset.metric=metric.key;
    button.addEventListener('click',()=>{selected=metric.key;render(false);});$('metric-tabs').append(button);
  });
  document.querySelectorAll('[data-trend]').forEach(button=>button.addEventListener('click',()=>{trendMode=button.dataset.trend;render(false);}));
  render(false);loadMap();
}
function render(animate=true){
  const snap=payload?.snapshot,values=currentMetrics(),targets=currentTargets();
  const dac=selectedCountry==='ALL' ? snap?.dac : regionData(selectedCountry)?.dac;
  kpis.forEach(kpi=>{
    const isRate=kpi.format==='percent',metric=kpi.key.replace('_rate','');
    const value=isRate ? rate(values?.[metric],targets?.[metric]) : kpi.key==='dac' ? dac : values?.[kpi.key];
    flipNumber($(`total-${kpi.key}`),value,animate);
    const card=$(`kpi-${kpi.key}`),foot=card.querySelector('.total-foot');
    foot.textContent=isRate ? (numeric(targets?.[metric]) ? `全天目标 $${compact(targets[metric])}` : '目标未配置') : kpi.key==='dac' ? (numeric(dac) ? '当日支付买家独立去重' : 'DAC 待更新 / 数据不完整') : `${regionName()} · 当日累计 USD`;
    foot.title=isRate ? `经管版全天目标：$${formatted(targets?.[metric])}` : foot.textContent;
    card.querySelector('.rate-bar span').style.width=`${isRate && numeric(value) ? Math.min(100,value) : 0}%`;
  });
  document.querySelectorAll('[data-country]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.country===selectedCountry)));
  document.querySelectorAll('[data-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.metric===selected)));
  document.querySelectorAll('[data-trend]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.trend===trendMode)));
  document.querySelectorAll('[data-market]').forEach(b=>{
    b.setAttribute('aria-pressed',String(b.dataset.market===selectedCountry));
    b.querySelector('b').textContent=numeric(regionData(b.dataset.market)?.metrics?.[selected]) ? `$${compact(regionData(b.dataset.market).metrics[selected])}` : '—';
  });
  text('trend-country',regionName());text('last-success',paidTime(snap?.success_at));text('latest-paid',paidTime(snap?.latest_paid));
  text('query-time',snap ? `${snap.query_seconds.toFixed(1)}s` : '—');text('tag-time',snap ? `${snap.tag_snapshot.ds} / ${snap.tag_snapshot.hh}:00` : '—');
  paintMap();renderTrend();renderInvestment();fitNumbers();updateStatus();
}
function svgNode(tag,attrs={},content){
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,String(v)));
  if(content!==undefined) node.textContent=content;return node;
}
function project(lon,lat){return [20+(lon+180)*920/360,35+(85-lat)*920/360];}
function geometryPath(geometry){
  const polygons=geometry.type==='Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map(polygon=>polygon.map(ring=>ring.map(([lon,lat],i)=>{
    const [x,y]=project(lon,lat);return `${i===0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ')+'Z').join(' ')).join(' ');
}
function bindRegion(node,code){
  node.dataset.region=code;node.setAttribute('role','button');node.setAttribute('tabindex','0');
  node.addEventListener('click',()=>selectCountry(code));
  node.addEventListener('keydown',event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();selectCountry(code);}});
}
async function loadMap(){
  try{
    const mapUrl=window.liveDataSource ? new URL('assets/world.json',document.baseURI) : '/assets/world.json';
        const response=await fetch(mapUrl,{signal:AbortSignal.timeout(15000)});if(!response.ok) throw new Error('地图未加载');
    const source=await response.json();if(source.type!=='FeatureCollection' || source.features.length<170) throw new Error('地图不完整');
    const map=$('world-map');map.replaceChildren(svgNode('rect',{x:0,y:0,width:960,height:510,class:'map-ocean'}));
    for(let lon=-180;lon<=180;lon+=30){const [x]=project(lon,0);map.append(svgNode('line',{x1:x,x2:x,y1:20,y2:475,class:'map-grid'}));}
    for(let lat=-60;lat<=80;lat+=20){const [,y]=project(0,lat);map.append(svgNode('line',{x1:20,x2:940,y1:y,y2:y,class:'map-grid'}));}
    source.features.forEach(feature=>{
      if(feature.properties.code==='ATA') return;
      const code=iso[feature.properties.code],path=svgNode('path',{d:geometryPath(feature.geometry),class:`land${code ? ' business' : ''}`,'fill-rule':'evenodd'});
      if(code){bindRegion(path,code);if(code==='ONE') path.dataset.member=feature.properties.name || feature.properties.code;path.append(svgNode('title'));}map.append(path);
    });
    countries.filter(([code])=>centers[code]).forEach(([code,name])=>{
      const [lon,lat,dx,dy]=centers[code],[x,y]=project(lon,lat),group=svgNode('g',{class:'map-marker',transform:`translate(${x},${y})`});
      bindRegion(group,code);group.append(svgNode('title'),svgNode('circle',{r:22,class:'halo'}),svgNode('circle',{r:14,class:'core'}),
        svgNode('path',{d:`M0,0 L${dx},${dy}`,class:'map-link'}),svgNode('text',{x:dx,y:dy-4,class:'map-label'},name),
        svgNode('text',{x:dx,y:dy+10,class:'map-label amount'},'—'));map.append(group);
    });
    mapLoaded=true;$('map-message').hidden=true;paintMap();
  }catch(error){text('map-message','地图加载失败；可使用国家筛选和下方地区列表');}
}
function paintMap(){
  if(!mapLoaded) return;
  const max=Math.max(1,...countries.filter(([c])=>centers[c]).map(([c])=>regionData(c)?.metrics?.[selected] || 0));
  document.querySelectorAll('#world-map [data-region]').forEach(node=>{
    const code=node.dataset.region,current=regionData(code),value=current?.metrics?.[selected],has=numeric(value),ratio=has ? Math.sqrt(value/max) : 0;
    const selectedRegion=selectedCountry===code,label=countries.find(c=>c[0]===code)[1];
    const target=payload?.targets?.countries?.[code]?.[selected],achievement=rate(value,target);
    const scopeLabel=code==='ONE' ? `${label}（66国合计，非本国数值；地图仅标示范围） · 成员 ${node.dataset.member}` : label;
    const title=`${scopeLabel} · ${metrics.find(m=>m.key===selected).label}：$${formatted(value)} · 达成率 ${formatted(achievement)}${numeric(achievement) ? '%' : '（目标或实际待更新）'}`;
    node.setAttribute('aria-label',title);node.setAttribute('aria-pressed',String(selectedRegion));node.querySelector('title').textContent=title;
    node.classList.toggle('selected',selectedRegion);node.classList.toggle('focused',selectedRegion);
    const fill=has ? `hsl(${205-ratio*15} 77% ${18+ratio*25}%)` : '#173752';
    if(node.tagName.toLowerCase()==='path') node.style.fill=code==='ONE' ? (selectedRegion ? '#197c89' : '#164756') : fill;
    else{
      node.querySelector('.core').setAttribute('r',has ? 7+ratio*17 : 5);node.querySelector('.core').style.fill=fill;
      node.querySelector('.halo').setAttribute('r',has ? 13+ratio*17 : 10);node.querySelector('.amount').textContent=has ? `$${compact(value)}` : '待更新';
    }
  });
}
function hourlyValues(){
  const snap=payload?.snapshot,regions=selectedCountry==='ALL' ? (snap?.complete ? snap.countries : []) : [regionData(selectedCountry)];
  if(!regions.length || regions.some(c=>!Array.isArray(c?.hours))) return Array(24).fill(null);
  const now=new Date(Date.now()+offset),day=dateFormat.format(now).replaceAll('-',''),currentHour=Number(hourFormat.format(now));
  const index=regions.map(c=>new Map(c.hours.map(h=>[h.hour,h.metrics])));
  return Array.from({length:24},(_,hour)=>{
    if(snap.business_day===day && hour>currentHour) return null;
    const rows=index.map(i=>i.get(hour));
    // 未取得该小时的完整地区结果时留空，不把其他地区的部分金额当作合计。
    if(rows.some(row=>!row)) return null;
    if(trendMode==='cumulative'){
      // 从原始小时结果分别累计，不能因较早某小时未显示而漏掉已观测成交。
      return Object.fromEntries(metrics.map(m=>[m.key,regions.reduce((sum,c)=>sum+c.hours.filter(h=>h.hour<=hour).reduce((v,h)=>v+h.metrics[m.key],0),0)]));
    }
    return Object.fromEntries(metrics.map(m=>[m.key,rows.reduce((sum,row)=>sum+row[m.key],0)]));
  });
}
function describeHour(hour,values){
  const snap=payload?.snapshot,now=new Date(Date.now()+offset),day=dateFormat.format(now).replaceAll('-','');
  const partial=snap?.business_day===day && hour===Number(hourFormat.format(now));
  return `${String(hour).padStart(2,'0')}:00${partial ? '（未结束）' : ''} · ${values ? metrics.map(m=>`${m.label} $${formatted(values[m.key])}`).join(' / ') : '数据未取得'}`;
}
function renderTrend(){
  const data=hourlyValues(),chart=$('hour-chart');chart.replaceChildren();
  $('trend-empty').hidden=data.some(Boolean);
  const left=64,right=613,top=28,bottom=318,x=hour=>left+(right-left)*hour/23;
  const max=Math.max(1,...data.filter(Boolean).flatMap(row=>metrics.map(m=>row[m.key])))*1.15,y=value=>bottom-(bottom-top)*value/max;
  for(let step=0;step<=4;step++){
    const value=max*step/4,cy=y(value);chart.append(svgNode('line',{x1:left,x2:right,y1:cy,y2:cy,class:'chart-grid'}),
      svgNode('text',{x:left-10,y:cy+4,class:'chart-text','text-anchor':'end'},compact(value)));
  }
  chart.append(svgNode('line',{x1:left,x2:right,y1:bottom,y2:bottom,class:'chart-axis'}),svgNode('text',{x:left,y:15,class:'chart-text'},'USD'));
  for(const hour of [0,3,6,9,12,15,18,21,23]) chart.append(svgNode('text',{x:x(hour),y:bottom+22,class:'chart-text','text-anchor':'middle'},`${String(hour).padStart(2,'0')}:00`));
  const now=new Date(Date.now()+offset),day=dateFormat.format(now).replaceAll('-',''),hour=Number(hourFormat.format(now));
  if(payload?.snapshot?.business_day===day){
    chart.append(svgNode('rect',{x:x(hour)-7,y:top,width:14,height:bottom-top,fill:'#149cd410'}),
      svgNode('line',{x1:x(hour),x2:x(hour),y1:top,y2:bottom,stroke:'#2585a6','stroke-dasharray':'3 5'}),
      svgNode('text',{x:Math.min(right-53,x(hour)+4),y:top-9,class:'chart-current'},`${hour}点未结束`));
  }
  metrics.forEach(metric=>{
    let d='',connected=false;
    data.forEach((row,h)=>{if(!row){connected=false;return;}d+=`${connected ? 'L' : 'M'}${x(h).toFixed(2)},${y(row[metric.key]).toFixed(2)} `;connected=true;});
    chart.append(svgNode('path',{d,class:'chart-line',stroke:colors[metric.key],'data-series':metric.key}));
    data.forEach((row,h)=>{if(row) chart.append(svgNode('circle',{cx:x(h),cy:y(row[metric.key]),r:3,fill:colors[metric.key],class:'chart-point'}));});
  });
  data.forEach((row,h)=>{
    if(!row) return;
    const hit=svgNode('rect',{x:x(h)-10,y:top,width:20,height:bottom-top,class:'chart-hit',tabindex:0,role:'img','aria-label':describeHour(h,row)});
    hit.append(svgNode('title',{},describeHour(h,row)));const show=()=>text('chart-detail',describeHour(h,row));
    hit.addEventListener('pointerenter',show);hit.addEventListener('focus',show);chart.append(hit);
  });
  $('hour-details').replaceChildren(...data.map((row,h)=>{
    const tr=document.createElement('tr');const first=document.createElement('td');first.textContent=`${String(h).padStart(2,'0')}:00`;tr.append(first);
    metrics.forEach(m=>{const td=document.createElement('td');td.textContent=formatted(row?.[m.key]);tr.append(td);});return tr;
  }));
  const latest=data.reduce((last,row,h)=>row ? h : last,-1);
  text('chart-detail',latest>=0 ? describeHour(latest,data[latest]) : '小时数据待更新；不会生成模拟成交曲线');
}
function updateStatus(){
  const snap=payload?.snapshot,now=Date.now()+offset,currentDay=dateFormat.format(new Date(now)).replaceAll('-','');
  const outdated=snap && (snap.business_day!==currentDay || (now-Date.parse(snap.success_at))/1000>(payload?.stale_after_seconds || 1800));
  const warnings=[];
  if(networkError) warnings.push('页面连接中断，保留最后成功快照');
  if(!snap) warnings.push(payload?.error || '正在查询真实成交，首次取数可能需要较长时间');
  if(snap?.business_day!==currentDay && snap) warnings.push(`当前 ${currentDay}；显示 ${snap.business_day} 历史快照和同日目标，等待新业务日数据`);
  if(snap && !snap.complete) warnings.push('部分地区未取得数据，美亚合计留空');
  if(payload?.error) warnings.push(payload.error);else if(outdated && snap?.business_day===currentDay) warnings.push('超过30分钟未取得成功快照，等待更新');
  if(snap && snap.schema_version!==2) warnings.push('旧快照仅有GMV，DAC及小时数据等待新版取数');
  if(snap?.missing_buyers>0) warnings.push(`有 ${integer.format(snap.missing_buyers)} 条记录缺少买家标识，相关DAC留空`);
  const sourceAge=snap ? Math.max(0,(now-Date.parse(snap.latest_paid))/60000) : null;
  if(sourceAge>30) warnings.push(`最近观测支付距今 ${Math.floor(sourceAge)} 分钟（不代表完整数据水位）`);
  if(snap && snap.tag_snapshot.ds<snap.business_day) warnings.push(`SD 使用 ${snap.tag_snapshot.ds} 最新标签，尚未同步到当日`);
  const targets=currentTargets();if(snap && metrics.some(m=>!numeric(targets?.[m.key]))) warnings.push('部分全天目标未配置，对应达成率留空');
  $('alert').hidden=!warnings.length;$('alert').textContent=warnings.join(' · ');
  const good=snap && !outdated && !networkError && !payload?.error;$('connection').classList.toggle('good',Boolean(good));
  $('connection').querySelector('span').textContent=good ? (window.liveDataSource ? '已解密 · 15min 发布周期' : payload.query_running ? '取数进行中' : '已连接 · 15min 数据周期') : '等待更新';
  text('business-day',snap ? `${snap.business_day.slice(0,4)}.${snap.business_day.slice(4,6)}.${snap.business_day.slice(6)}` : dateFormat.format(new Date(now)));
}
async function refresh(){
  if(fetchRunning || suspended) return;fetchRunning=true;nextPoll=Date.now()+60000;
  const version=responseGeneration;
  try{
    let fresh;
    if(window.liveDataSource){
      if(window.liveDataSource.locked()) return;
      fresh=await window.liveDataSource.read();if(!fresh) return;
    }else{
      const response=await fetch('/api/snapshot',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(response.status===401){clearSensitive();location.replace('/login');return;}if(!response.ok) throw new Error('连接失败');
      fresh=await response.json();
    }
    if(version!==responseGeneration || suspended || window.liveDataSource?.locked()) return;
    if(!fresh || !fresh.server_time || !('snapshot' in fresh)) throw new Error('响应异常');
    // 静态快照时间不是实时服务器时钟，不能反复把浏览器时钟拨回采集时刻。
    offset=window.liveDataSource ? 0 : Date.parse(fresh.server_time)-Date.now();payload=fresh;networkError=false;render();
  }catch(error){if(version===responseGeneration && !suspended){networkError=true;updateStatus();}}
  finally{fetchRunning=false;if(Date.now()>=nextPoll) nextPoll=Date.now()+60000;}
}
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement) await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch(error){$('fullscreen').title='浏览器当前不允许全屏';}});
document.addEventListener('fullscreenchange',()=>{const label=document.fullscreenElement ? '退出全屏' : '进入全屏';$('fullscreen').title=label;$('fullscreen').setAttribute('aria-label',label);});
$('logout').addEventListener('click',async()=>{suspended=true;clearSensitive();if(window.liveDataSource){window.liveDataSource.lock();return;}try{const response=await fetch('/api/logout',{method:'POST'});if(response.ok) location.replace('/login');}catch(error){networkError=true;updateStatus();}});
window.addEventListener('live-unlocked',()=>{suspended=false;refresh();});
window.addEventListener('live-locked',()=>{suspended=true;clearSensitive();});
window.addEventListener('pagehide',()=>{suspended=true;clearSensitive();});
window.addEventListener('pageshow',()=>{if(!window.liveDataSource?.locked()){suspended=false;refresh();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && Date.now()>=nextPoll) refresh();});
window.addEventListener('resize',()=>requestAnimationFrame(fitNumbers));
initialize();refresh();
setInterval(()=>{
  text('clock',timeFormat.format(new Date(Date.now()+offset)));text('countdown',`${Math.max(0,Math.ceil((nextPoll-Date.now())/1000))}s`);
  const left=payload?.next_refresh_at ? Math.max(0,Math.ceil((Date.parse(payload.next_refresh_at)-Date.now()-offset)/1000)) : null;
  text('collector-countdown',payload?.query_running ? '进行中' : left===null ? '—' : left===0 ? (window.liveDataSource ? '等待新快照' : '即将取数') : `${Math.floor(left/60)}分${String(left%60).padStart(2,'0')}秒`);
  updateStatus();renderInvestment();if(Date.now()>=nextPoll && !fetchRunning) refresh();
},1000);
