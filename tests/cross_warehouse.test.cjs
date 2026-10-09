const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname,'..');
const backend = fs.readFileSync(path.join(ROOT,'backend/Code.gs'),'utf8');
const page = fs.readFileSync(path.join(ROOT,'web/index.html'),'utf8');
const frontend = page.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)?.[1];
assert.ok(frontend,'Inline frontend script not found');
const functions = frontend.slice(0,frontend.indexOf("document.querySelectorAll('.tab')"));
assert.ok(functions.includes('function localToday()'));
const config = fs.readFileSync(path.join(ROOT,'web/config.js'),'utf8');
const now = Date.parse('2026-10-09T10:03:00Z');
class Clock extends Date {
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
}
const HEADERS = [
  'ID','Karyawan','Divisi','Tanggal','Jam Masuk','Jadwal Masuk','Telat Menit',
  'Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Jam Pulang','Lat Pulang',
  'Lon Pulang','Akurasi Pulang','Lembur Jam','Host','Status','Dibuat','Diubah',
  'Gudang','Jobdesk Pulang','Gudang Pulang'
];
function row(origin='PARAKAN') {
  return ['in-1','Karyawan Uji','GUDANG','2026-10-09','09:00:00','09:00',0,
    -6.622239,106.771941,15,'photo','','','','',0,'host','MASUK','created','modified',origin,'',''];
}
function sheet({warehouse='PARAKAN',header=HEADERS,rowData=row(warehouse)}={}){
  const rows = [header.slice(),rowData.slice()];
  let columns = 25;
  const getRange = (r,c,rs=1,cs=1)=>({
    getValue:()=>rows[r-1]?.[c-1]??'',
    getDisplayValue:()=>String(rows[r-1]?.[c-1]??''),
    getValues:()=>Array.from({length:rs},(_,i)=>Array.from({length:cs},(_,j)=>rows[r+i-1]?.[c+j-1]??'')),
    getDisplayValues:()=>Array.from({length:rs},(_,i)=>Array.from({length:cs},(_,j)=>String(rows[r+i-1]?.[c+j-1]??''))),
    setValue:(v)=>{if(!rows[r-1])rows[r-1]=[];rows[r-1][c-1]=v;},
    setValues:(matrix)=>{for(let i=0;i<matrix.length;i++){if(!rows[r+i-1])rows[r+i-1]=[];for(let j=0;j<matrix[i].length;j++)rows[r+i-1][c+j-1]=matrix[i][j];}},
    createTextFinder:(text)=>({matchEntireCell(){return this;},matchCase(){return this;},useRegularExpression(){return this;},findNext(){const ii=rows.findIndex((line,k)=>k>0 && line[c-1]===text);return ii<0?null:{getRow:()=>ii+1};}}),
    clearContent(){for(let i=r-1;i<r-1+rs;i++)for(let j=c-1;j<c-1+cs;j++)if(rows[i])rows[i][j]='';}
  });
  const sh={rows,getRange,getLastRow:()=>rows.length,getLastColumn:()=>columns,getMaxColumns:()=>columns,
    insertColumnsAfter:(_n,num)=>{columns+=num;},
    deleteColumn:(c)=>{rows.forEach(x=>x.splice(c-1,1));columns--;},
    appendRow:(r)=>rows.push(r.slice())};
  return sh;
}
function backendVM(sh){
  const ctx = vm.createContext({Date:Clock,Math,console,JSON,
    SpreadsheetApp:{openById:()=>({getSheetByName:()=>sh})},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},
    Utilities:{formatDate:(_date,_tz,fmt)=>fmt==='yyyy-MM-dd'?'2026-10-09':fmt==='HH:mm:ss'?'17:03:00':'',getUuid:()=> 'new-id'}
  });
  vm.runInContext(backend,ctx);
  return ctx;
}
function localRecord(wh='PARAKAN'){
  return {id:'in-1',employee:'Karyawan Uji',warehouse:wh,date:'2026-10-09',division:'GUDANG',inLocal:'09:00:00',outLocal:null,source:'server'};
}
function browser({selected='CM',initial=localRecord()}={}){
  const mem = new Map();
  mem.set('absensi.warehouse',selected);
  const alerts=[],elements=new Map();
  function element(id){if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',innerHTML:'',className:'',disabled:false,dataset:{},classList:{add(){},remove(){}},remove(){}});return elements.get(id);}
  const ctx=vm.createContext({Date:Clock,Math,JSON,Intl,URL,AbortController,Promise,Map,console,
    localStorage:{getItem:key=>mem.get(key)||null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)},
    document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({remove(){}}),head:{appendChild(){}}},
    navigator:{},alert:x=>alerts.push(String(x)),fetch:async()=>({type:'opaque'}),
    setTimeout,clearTimeout,window:{ABSENSI_CONFIG:{GAS_ENDPOINT:'https://script.google.com/macros/s/test/exec',APP_VERSION:'1.9.9'}}
  });
  element('employee').value='Karyawan Uji';element('division').value='GUDANG';
  element('outWork').value='Sortir dan packing selesai';
  vm.runInContext(functions,ctx);
  vm.runInContext("delay=async()=>{};getGps=async()=>{gps={lat:-6.6265,lon:106.7791667,accuracy:12};};render=()=>{};",ctx);
  if(initial)ctx.saveRecords([initial]);
  return {ctx,mem,alerts,element};
}

test('all four warehouse geofences are 200 m, coordinates unchanged',()=>{
  const points=[['KEBANDUNGAN','-6.633483','106.775966'],['PARAKAN','-6.622239','106.771941'],['CM','-6.6265','106.7791667'],['NANAS','-6.618490474658237','106.78478377021241']];
  for(const [code,lat,lon] of points){
    assert.ok(config.includes(`LAT:${lat}, LON:${lon}, RADIUS_M:200`),code+' frontend');
    assert.ok(backend.includes(`lat:${lat}, lon:${lon}, radiusM:200`),code+' backend');
  }
});

test('today finds original check-in in different warehouse, and same CM/Parakan',()=>{
  for(const origin of ['CM','PARAKAN']){
    const sh=sheet({warehouse:origin});const ctx=backendVM(sh);
    assert.equal(ctx.getToday_('Karyawan Uji',origin,'2026-10-09').record.warehouse,origin);
    const other=origin==='CM'?'PARAKAN':'CM';
    assert.equal(ctx.getToday_('Karyawan Uji',other,'2026-10-09').record.warehouse,origin);
  }
});

test('backend cross-warehouse checkout updates original row and logs chosen warehouse',()=>{
  const sh=sheet();const ctx=backendVM(sh);
  const result=ctx.saveCheckout_(sh,{id:'in-1',employee:'Karyawan Uji',warehouse:'PARAKAN',checkoutWarehouse:'CM',outGps:{lat:-6.6265,lon:106.7791667,accuracy:12},outWork:'Selesai sortir'});
  assert.equal(result.ok,true);assert.equal(sh.rows.length,2);
  assert.equal(sh.rows[1][20],'PARAKAN');assert.equal(sh.rows[1][21],'Selesai sortir');assert.equal(sh.rows[1][22],'CM');
  assert.equal(sh.rows[1][17],'PULANG');assert.equal(result.record.checkoutWarehouse,'CM');
});

test('backend same-warehouse checkout for CM and Parakan succeeds',()=>{
  for(const w of ['CM','PARAKAN']){
    const sh=sheet({warehouse:w});const ctx=backendVM(sh);
    const result=ctx.saveCheckout_(sh,{id:'in-1',employee:'Karyawan Uji',warehouse:w,checkoutWarehouse:w,outGps:{lat:-6.6265,lon:106.7791667,accuracy:12},outWork:'Selesai packing'});
    assert.equal(result.ok,true,w);assert.equal(sh.rows[1][20],w);assert.equal(sh.rows[1][22],w);
  }
});

test('wrong employee or invalid checkout warehouse is rejected without marking checkout',()=>{
  const sh=sheet();const ctx=backendVM(sh);
  const rec={id:'in-1',employee:'Karyawan Uji',warehouse:'PARAKAN',checkoutWarehouse:'CM',outGps:{lat:-6.6265,lon:106.7791667,accuracy:10},outWork:'Packing'};
  assert.throws(()=>ctx.saveCheckout_(sh,{...rec,employee:'Other'}),/tidak cocok/);
  assert.throws(()=>ctx.saveCheckout_(sh,{...rec,checkoutWarehouse:'UNKNOWN'}),/Gudang pulang tidak valid/);
  assert.equal(sh.rows[1][17],'MASUK');
});

test('existing spreadsheet with Column 1 in W is migrated without shifting U or V',()=>{
  const sh=sheet();sh.rows[0][22]='Column 1';sh.rows[1][21]='Jobdesk lama';
  const ctx=backendVM(sh);ctx.ensureHeader_(sh);
  assert.equal(sh.rows[0][22],'Gudang Pulang');
  assert.equal(sh.rows[1][20],'PARAKAN');assert.equal(sh.rows[1][21],'Jobdesk lama');
  assert.equal(sh.rows[1][22],'');
});

test('frontend local lookup, submission, and confirmation work when leaving a different warehouse',async()=>{
  const b=browser();let sent=null;
  assert.equal(b.ctx.localToday().warehouse,'PARAKAN');
  b.ctx.sendWrite=async payload=>{sent=payload;};
  b.ctx.jsonp=async p=>{
    assert.equal(p.action,'writeStatus');
    return {ok:true,pending:false,result:{ok:true,record:{...localRecord('PARAKAN'),outLocal:'17:03:00',checkoutWarehouse:'CM',checkoutWork:'Sortir dan packing selesai',overtime:0}}};
  };
  await b.ctx.performCheckOut();
  assert.equal(sent.record.warehouse,'PARAKAN');assert.equal(sent.record.checkoutWarehouse,'CM');
  assert.equal(b.ctx.localToday().outLocal,'17:03:00');
  assert.equal(b.ctx.pendingCheckouts().length,0);
  assert.match(b.alerts.at(-1),/terverifikasi/);
});

test('frontend can read original record from server when leaving different warehouse from another device',async()=>{
  const b=browser({selected:'CM',initial:null});let sent=null;
  b.ctx.sendWrite=async payload=>{sent=payload;};
  b.ctx.jsonp=async p=>p.action==='today'?{ok:true,record:localRecord('KEBANDUNGAN')}:
    {ok:true,pending:false,result:{ok:true,record:{...localRecord('KEBANDUNGAN'),outLocal:'17:03:00',checkoutWarehouse:'CM',checkoutWork:'Sortir dan packing selesai'}}};
  await b.ctx.performCheckOut();
  assert.equal(sent.record.warehouse,'KEBANDUNGAN');
  assert.equal(sent.record.checkoutWarehouse,'CM');
  assert.equal(b.ctx.localToday().outLocal,'17:03:00');
});
