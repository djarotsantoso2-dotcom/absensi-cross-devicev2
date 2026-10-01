const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const frontend = html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)[1];
const functions = frontend.slice(0, frontend.indexOf("document.querySelectorAll('.tab')"));
const backend = fs.readFileSync(path.join(root, 'backend/Code.gs'), 'utf8');
const NOW = Date.parse('2026-10-01T15:02:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
const baseRecord = () => ({id:'in-1',employee:'Mas Suryo',warehouse:'KEBANDUNGAN',date:'2026-10-01',division:'GUDANG',inLocal:'09:00:00',out:null,outLocal:null,source:'server',inPhoto:'data:image/jpeg;base64,'+'X'.repeat(100000)});
const confirmedRecord = () => ({...baseRecord(),outLocal:'22:02:00',overtime:4.53});

function browser(storage=new Map()) {
  let elapsed=0, seq=0;
  const timers=new Map(), scripts=[], alerts=[], elements=new Map();
  function element(id='') {
    if(!elements.has(id)) elements.set(id,{value:'',disabled:false,textContent:'',innerHTML:'',dataset:{},className:'',classList:{add(){},remove(){}},remove(){this.removed=true;}});
    return elements.get(id);
  }
  const ctx=vm.createContext({Date:Clock,Intl,URL,AbortController,console,Map,Promise,
    setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,at:elapsed+ms});return id;},clearTimeout(id){timers.delete(id);},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    document:{getElementById:element,createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)},querySelectorAll:()=>[element('checkIn'),element('checkOut'),element('employee'),element('division')]},
    navigator:{},alert:x=>alerts.push(x),fetch:async()=>({type:'opaque'}),
    window:{ABSENSI_CONFIG:{GAS_ENDPOINT:'https://script.google.com/macros/s/test/exec',APP_VERSION:'1.9.9'}}
  });
  element('employee').value='Mas Suryo';element('division').value='GUDANG';
  storage.set('absensi.warehouse','KEBANDUNGAN');
  vm.runInContext(functions,ctx);
  function override(code){vm.runInContext(code,ctx);}
  function advance(ms){elapsed+=ms;for(const [id,t] of [...timers]) if(t.at<=elapsed){timers.delete(id);t.fn();}}
  override('delay=async()=>{};getGps=async()=>{gps={lat:-6.633483,lon:106.775966,accuracy:5};};');
  return {ctx,storage,scripts,alerts,element,override,advance,timers};
}

test('all shipped JavaScript parses, including complete page bootstrap',()=>{
  for(const source of [frontend,backend,fs.readFileSync(path.join(root,'web/config.js'),'utf8'),fs.readFileSync(path.join(root,'web/sw.js'),'utf8')]) new vm.Script(source);
  JSON.parse(fs.readFileSync(path.join(root,'web/manifest.webmanifest'),'utf8'));
});

test('JSONP accepts a response after 17 seconds, beyond the former 12-second limit',async()=>{
  const b=browser();const promise=b.ctx.jsonp({action:'health'});
  const url=new URL(b.scripts[0].src), cb=url.searchParams.get('callback');
  b.advance(17000);assert.equal(typeof b.ctx.window[cb],'function');
  b.ctx.window[cb]({ok:true});assert.equal((await promise).ok,true);
  assert.equal(b.scripts[0].removed,true);assert.equal(b.timers.size,0);
});

test('JSONP timeout is bounded and a late callback remains harmless',async()=>{
  const b=browser();const promise=b.ctx.jsonp({action:'today'});
  const cb=new URL(b.scripts[0].src).searchParams.get('callback');
  const failed=assert.rejects(promise,e=>e.retryable===true);
  b.advance(45000);await failed;
  assert.doesNotThrow(()=>b.ctx.window[cb]({ok:true}));
  b.advance(60000);assert.equal(b.ctx.window[cb],undefined);
});

test('HTML or missing JSONP callback reports a connection error immediately',async()=>{
  const b=browser();const failed=assert.rejects(b.ctx.jsonp({action:'health'}),/URL dan akses/);
  b.scripts[0].onload();await failed;
});

test('today retries a transient failure and shares simultaneous reads',async()=>{
  const b=browser();let reads=0;
  b.ctx.jsonp=async()=>{reads++;if(reads===1) throw b.ctx.connectionError('temporary');return {ok:true,record:baseRecord()};};
  const [a,c]=await Promise.all([b.ctx.serverToday(),b.ctx.serverToday()]);
  assert.equal(reads,2);assert.equal(a.id,c.id);
});

test('today does not retry a business error',async()=>{
  const b=browser();let reads=0;b.ctx.jsonp=async()=>{reads++;return {ok:false,error:'Struktur sheet salah'};};
  await assert.rejects(b.ctx.serverToday(),/Struktur sheet salah/);assert.equal(reads,1);
});

test('checkout bypasses the blocking read, sends no check-in photo, and confirms before marking done',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);let payload;
  b.ctx.serverToday=async()=>{throw new Error('checkout must not need a preliminary GET');};
  b.ctx.fetch=async(ep,options)=>{payload=JSON.parse(options.body);assert.equal(b.ctx.localToday().outLocal,null);return {type:'opaque'};};
  b.ctx.jsonp=async params=>{assert.equal(params.action,'writeStatus');return {ok:true,pending:false,result:{ok:true,record:confirmedRecord()}};};
  await b.ctx.checkOut();
  assert.deepEqual(Object.keys(payload.record).sort(),['date','employee','id','outGps','warehouse']);
  assert.ok(JSON.stringify(payload).length<500);assert.equal(b.ctx.localToday().outLocal,'22:02:00');
  assert.equal(b.ctx.pendingCheckouts().length,0);assert.match(b.alerts.at(-1),/terverifikasi/);
  assert.equal(b.element('checkOut').disabled,false);
});

test('unconfirmed checkout survives reload, retains the request id, and never creates false success',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);
  b.ctx.jsonp=async()=>{throw b.ctx.connectionError('offline');};
  await b.ctx.checkOut();
  const id=b.ctx.pendingCheckout().payload.requestId;
  assert.equal(b.ctx.localToday().outLocal,null);assert.equal(b.ctx.pendingCheckouts().length,1);
  assert.match(b.alerts.at(-1),/belum terkonfirmasi/);
  const reloaded=browser(b.storage);let sent;
  reloaded.ctx.fetch=async(ep,opt)=>{sent=JSON.parse(opt.body);throw new TypeError('response lost');};
  reloaded.ctx.jsonp=async()=>({ok:true,pending:false,result:{ok:true,record:confirmedRecord()}});
  await reloaded.ctx.checkOut();
  assert.equal(sent.requestId,id);assert.equal(reloaded.ctx.pendingCheckouts().length,0);
  assert.equal(reloaded.ctx.localToday().outLocal,'22:02:00');
});

test('old backend fallback confirms checkout by its row',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);
  b.ctx.jsonp=async params=>params.action==='writeStatus'?{ok:false,error:'Action tidak dikenal'}:{ok:true,record:confirmedRecord()};
  await b.ctx.checkOut();assert.equal(b.ctx.localToday().outLocal,'22:02:00');
});

test('a checkout rejection is shown without marking the record done',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);
  b.ctx.jsonp=async()=>({ok:true,pending:false,result:{ok:false,error:'Server sedang sibuk'}});
  await b.ctx.checkOut();assert.equal(b.ctx.localToday().outLocal,null);assert.match(b.alerts.at(-1),/Server sedang sibuk/);
});

test('confirmation for another warehouse is rejected',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);
  b.ctx.jsonp=async()=>({ok:true,pending:false,result:{ok:true,record:{...confirmedRecord(),warehouse:'CM'}}});
  await b.ctx.checkOut();assert.equal(b.ctx.localToday().outLocal,null);assert.match(b.alerts.at(-1),/tidak cocok/);
});

test('cross-device checkout first reads the server when there is no local check-in',async()=>{
  const b=browser();let reads=0;
  b.ctx.jsonp=async params=>{if(params.action==='today'){reads++;return {ok:true,record:baseRecord()};}return {ok:true,pending:false,result:{ok:true,record:confirmedRecord()}};};
  await b.ctx.checkOut();assert.equal(reads,1);assert.equal(b.ctx.localToday().outLocal,'22:02:00');
});

test('double clicks send exactly one write',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);let writes=0, release;
  b.ctx.fetch=()=>{writes++;return new Promise(resolve=>release=resolve);};
  b.ctx.jsonp=async()=>({ok:true,pending:false,result:{ok:true,record:confirmedRecord()}});
  const first=b.ctx.checkOut();await Promise.resolve();await Promise.resolve();
  await b.ctx.checkOut();assert.equal(writes,1);release({type:'opaque'});await first;
});

test('a background read started before checkout cannot undo its confirmed status',async()=>{
  const b=browser();b.ctx.saveRecords([baseRecord()]);let release;
  b.ctx.serverToday=()=>new Promise(resolve=>release=resolve);
  const stale=b.ctx.hydrateTodayFromServer();
  b.ctx.jsonp=async()=>({ok:true,pending:false,result:{ok:true,record:confirmedRecord()}});
  await b.ctx.checkOut();release(baseRecord());await stale;
  assert.equal(b.ctx.localToday().outLocal,'22:02:00');
});

test('POST has a bounded timeout and aborts without claiming success',async()=>{
  const b=browser();b.ctx.fetch=(ep,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
  const failed=assert.rejects(b.ctx.sendWrite({type:'checkout'}),e=>e.retryable===true);
  b.advance(45000);await failed;assert.equal(b.timers.size,0);
});

function gas(rows,options={}) {
  const cache=new Map(), reads=[], writes=[];let releases=0, flushes=0, opened='';
  let ctx;
  const sheet={
    getLastRow:()=>rows.length,getLastColumn:()=>22,
    getRange(row,col,n=1,width=1){
      return {
        getValues(){reads.push({row,col,n,width});return Array.from({length:n},(_,i)=>Array.from({length:width},(_,j)=>rows[row+i-1]?.[col+j-1]??''));},
        getDisplayValues(){return this.getValues().map(r=>r.map(v=>String(v)));},getDisplayValue(){return String(this.getValue());},getValue(){return rows[row-1]?.[col-1]??'';},
        setValue(value){rows[row-1][col-1]=value;return this;},
        setValues(values){writes.push({row,col,n,width});values.forEach((r,i)=>r.forEach((v,j)=>rows[row+i-1][col+j-1]=v));return this;},
        clearContent(){},
        createTextFinder(text){return {matchEntireCell(){return this;},matchCase(){return this;},useRegularExpression(){return this;},findNext(){const found=rows.findIndex((r,i)=>i>=row-1&&i<row-1+n&&String(r[col-1])===text);return found<0?null:{getRow:()=>found+1};}};}
      };
    },appendRow:r=>rows.push(r)
  };
  const formatDate=(date,tz,pattern)=>{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const get=t=>parts.find(p=>p.type===t).value;
    return pattern==='yyyy-MM-dd'?`${get('year')}-${get('month')}-${get('day')}`:`${get('hour')}:${get('minute')}:${get('second')}`;
  };
  ctx=vm.createContext({Date:Clock,console,
    SpreadsheetApp:{openById(id){opened=id;return {getSheetByName:()=>sheet};},flush(){flushes++;}},
    LockService:{getScriptLock:()=>({tryLock(ms){assert.equal(ms,10000);return options.lock!==false;},releaseLock(){releases++;}})},
    CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put(k,v,ttl){assert.equal(ttl,600);if(options.cacheFails) throw new Error('cache unavailable');cache.set(k,v);}})},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},
    Utilities:{formatDate,getUuid:()=> 'uuid'},
    DriveApp:{getFolderById(){throw new Error('checkout must not upload a photo');}},
    ContentService:{MimeType:{JSON:'json',JAVASCRIPT:'javascript'},createTextOutput(text){return {text,setMimeType(){return this;}};}}
  });
  vm.runInContext(backend,ctx);
  function post(record,id='out_test'){return JSON.parse(ctx.doPost({postData:{contents:JSON.stringify({type:'checkout',requestId:id,record})}}).text);}
  return {ctx,sheet,post,cache,reads,writes,get releases(){return releases;},get flushes(){return flushes;},get opened(){return opened;}};
}
function sheetRows(count=1){
  const headers=['ID','Karyawan','Divisi','Tanggal','Jam Masuk','Jadwal Masuk','Telat Menit','Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Pekerjaan','Jam Pulang','Lat Pulang','Lon Pulang','Akurasi Pulang','Lembur Jam','Host','Status','Dibuat','Diubah','Gudang'];
  const rows=[headers];
  for(let i=0;i<count;i++) rows.push([i===count-1?'in-1':'old-'+i,i===count-1?'Mas   Suryo':'Other','GUDANG',i===count-1?new Clock('2026-10-01T02:00:00Z'):'2026-09-30','09:00:00','09:00',0,0,0,5,'photo','work','','','','',0,'host','MASUK',new Clock(),new Clock(),'KEBANDUNGAN']);
  return rows;
}
const outPayload=()=>({id:'in-1',employee:'mas suryo',warehouse:'KEBANDUNGAN',date:'2026-10-01',outGps:{lat:-6.633483,lon:106.775966,accuracy:5}});

test('backend saves checkout, publishes its result, and retries without changing the first checkout time',()=>{
  const rows=sheetRows(), g=gas(rows);const result=g.post(outPayload());
  assert.equal(result.ok,true);assert.equal(result.record.outLocal,'22:02:00');assert.equal(g.releases,1);assert.equal(g.flushes,1);
  const status=g.ctx.getWriteStatus_({requestId:'out_test',employee:'Mas Suryo',warehouse:'KEBANDUNGAN'});
  assert.equal(status.result.record.outLocal,'22:02:00');
  const again=g.post(outPayload());assert.equal(again.duplicate,true);assert.equal(g.writes.length,1);
  assert.equal(g.opened,'1yELZY2kInp3AiDx7jvQBpAlgWF238oGN-qfZlETS0YQ');
});

test('backend lock contention returns a readable result and does not release an unowned lock',()=>{
  const g=gas(sheetRows(),{lock:false});assert.equal(g.post(outPayload()).ok,false);
  assert.match(g.ctx.getWriteStatus_({requestId:'out_test',employee:'Mas Suryo',warehouse:'KEBANDUNGAN'}).result.error,/sedang sibuk/);
  assert.equal(g.releases,0);assert.equal(g.writes.length,0);
});

test('cache failure cannot turn a committed checkout into a failed write',()=>{
  const g=gas(sheetRows(),{cacheFails:true});assert.equal(g.post(outPayload()).ok,true);
  assert.equal(g.ctx.getWriteStatus_({requestId:'out_test',employee:'Mas Suryo',warehouse:'KEBANDUNGAN'}).pending,true);
});

test('backend rejects wrong identity, date, or invalid checkout GPS',()=>{
  for(const change of [{employee:'Other'},{warehouse:'CM'},{outGps:{lat:91,lon:0}},{outGps:{lat:null,lon:0}}]){
    const g=gas(sheetRows());assert.equal(g.post({...outPayload(),...change}).ok,false);assert.equal(g.writes.length,0);
  }
  const rows=sheetRows();rows[1][3]='2026-09-30';const g=gas(rows);assert.equal(g.post(outPayload()).ok,false);assert.equal(g.writes.length,0);
});

test('confirmation cannot be read as another employee or warehouse',()=>{
  const g=gas(sheetRows());g.post(outPayload());
  assert.throws(()=>g.ctx.getWriteStatus_({requestId:'out_test',employee:'Other',warehouse:'KEBANDUNGAN'}),/tidak cocok/);
  assert.throws(()=>g.ctx.getWriteStatus_({requestId:'out_test',employee:'Mas Suryo',warehouse:'CM'}),/tidak cocok/);
});

test('today reads only the latest block when current rows sit in a 10,000-row history',()=>{
  const g=gas(sheetRows(10000));const result=g.ctx.getToday_(' mas  suryo ','KEBANDUNGAN');
  assert.equal(result.record.id,'in-1');assert.ok(g.reads.every(r=>r.n<=250));
  assert.equal(g.reads.filter(r=>r.n>1).length,1);
});

test('block search still finds a current row beyond the latest block and respects warehouses',()=>{
  const rows=sheetRows(700);rows[1]=rows.at(-1).slice();rows[1][0]='older-position';rows.at(-1)[3]='2026-09-30';
  const g=gas(rows);assert.equal(g.ctx.getToday_('Mas Suryo','KEBANDUNGAN').record.id,'older-position');
  assert.equal(g.ctx.getToday_('Mas Suryo','CM').record,null);assert.ok(g.reads.every(r=>r.n<=250));
});

test('WIB date rollover is independent of the device timezone',()=>{
  const b=browser();assert.equal(b.ctx.localDate(new Clock('2026-09-30T16:59:59Z')),'2026-09-30');
  assert.equal(b.ctx.localDate(new Clock('2026-09-30T17:00:00Z')),'2026-10-01');
});
