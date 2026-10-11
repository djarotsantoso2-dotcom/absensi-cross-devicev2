const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const be=fs.readFileSync(path.join(root,'backend/Code.gs'),'utf8');
const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const js=html.match(/<script>\s*('use strict';[\s\S]*?)<\/script>/)?.[1];
assert.ok(js,'missing browser JavaScript');
const body=js.split("document.querySelectorAll('.tab').forEach")[0];
class FakeDate extends Date {
 constructor(...args){super(...(args.length?args:['2026-10-11T02:00:00Z']));}
 static now(){return Date.parse('2026-10-11T02:00:00Z');}
}
const head=['ID','Karyawan','Divisi','Tanggal','Jam Masuk','Jadwal Masuk','Telat Menit','Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Jam Pulang','Lat Pulang','Lon Pulang','Akurasi Pulang','Lembur Jam','Host','Status','Dibuat','Diubah','Gudang','Jobdesk Pulang','Gudang Pulang'];
function fakeSheet(){
 const rows=[head.slice()];
 const sh={rows,getLastRow:()=>rows.length,getMaxColumns:()=>25,
   appendRow:r=>rows.push(r.slice()),
   getRange(r,c,n=1,k=1){return {
     getValue:()=>rows[r-1]?.[c-1]||'',getDisplayValue:()=>String(rows[r-1]?.[c-1]||''),
     getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:k},(_,j)=>rows[r-1+i]?.[c-1+j]||'')),
     getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:k},(_,j)=>String(rows[r-1+i]?.[c-1+j]||''))),
     createTextFinder:val=>({matchEntireCell(){return this;},matchCase(){return this;},useRegularExpression(){return this;},findNext(){const i=rows.findIndex((line,i)=>i>0&&line[c-1]===val);return i<0?null:{getRow:()=>i+1};}}),
     setValue(v){rows[r-1][c-1]=v;},setValues(a){a.forEach((rr,i)=>rr.forEach((v,j)=>{rows[r+i-1][c+j-1]=v;}));}
   }}
 };return sh;
}
function backend(sh,now='2026-10-11T02:00:00Z'){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return Date.parse(now);}}
 const ctx=vm.createContext({Date:Clock,JSON,console,Math,
  SpreadsheetApp:{openById:()=>({getSheetByName:()=>sh})},
  PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})},
  Utilities:{formatDate:(d,_tz,fmt)=>{
   const t=new Date(d.getTime()+7*3600000);if(fmt==='yyyy-MM-dd')return t.toISOString().slice(0,10);if(fmt==='HH:mm:ss')return t.toISOString().slice(11,19);return '';
  },getUuid:()=> 'uuid'},
 });
 vm.runInContext(be,ctx);ctx.savePhoto_=()=> 'photoUrl';return ctx;
}
function local(){return {id:'local-in-1',employee:'Karyawan Test',division:'PACKING',warehouse:'CM',date:'2026-10-11',in:'2026-10-11T01:55:03.000Z',inLocal:'08:55:03',inGps:{lat:-6.6265,lon:106.7791667,accuracy:7},inPhoto:'data:image/jpeg;base64,abcd'};}
test('recover preserves captured device clock, GPS and photo, but audits receipt timestamp',()=>{
 const sh=fakeSheet(),s=backend(sh);
 const result=s.saveCheckin_(sh,{...local(),recovery:true});
 assert.equal(result.ok,true);assert.equal(sh.rows.length,2);
 assert.equal(sh.rows[1][3],'2026-10-11');assert.equal(sh.rows[1][4],'08:55:03');
 assert.equal(sh.rows[1][7],-6.6265);assert.equal(sh.rows[1][10],'photoUrl');
 assert.equal(sh.rows[1][18].toISOString(),'2026-10-11T02:00:00.000Z');
});
test('retry same ID and same employee/day does not create duplicate or upload photo twice',()=>{
 const sh=fakeSheet(),s=backend(sh);let files=0;s.savePhoto_=()=>{files++;return 'photoUrl';};
 const first=s.saveCheckin_(sh,{...local(),recovery:true});
 const second=s.saveCheckin_(sh,{...local(),recovery:true});
 assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(second.duplicate,true);
 assert.equal(sh.rows.length,2);assert.equal(files,1);
 const renamed={...local(),id:'new-id'};
 const third=s.saveCheckin_(sh,{...renamed,recovery:true});
 assert.equal(third.conflict,true);assert.equal(sh.rows.length,2);assert.equal(files,1);
});
test('recovery older than 72h and future time are rejected',()=>{
 const sh=fakeSheet(),s=backend(sh);
 assert.throws(()=>s.saveCheckin_(sh,{...local(),in:'2026-10-01T01:55:03Z',date:'2026-10-01',recovery:true}),/72 jam/);
 assert.throws(()=>s.saveCheckin_(sh,{...local(),in:'2026-10-11T03:00:03Z',recovery:true}),/72 jam/);
 assert.equal(sh.rows.length,1);
});
test('read-only checkinStatus matches same ID and name even on another date',()=>{
 const sh=fakeSheet(),s=backend(sh);
 s.saveCheckin_(sh,{...local(),recovery:true});
 const same=s.getCheckinStatus_({id:'local-in-1',employee:'Karyawan Test',warehouse:'CM',date:'2026-10-11'});
 assert.equal(same.ok,true);assert.equal(same.record.id,'local-in-1');
 const wrong=s.getCheckinStatus_({id:'local-in-1',employee:'Orang lain',warehouse:'CM',date:'2026-10-11'});
 assert.equal(wrong.record,null);assert.equal(sh.rows.length,2);
});
test('frontend includes sync button, original record recovery and server writeStatus error path',()=>{
 assert.ok(html.includes('id="retryCheckIn"'));
 assert.ok(body.includes('async function retryLocalCheckins()'));
 assert.ok(body.includes('async function syncOneLocalCheckin(r)'));
 assert.ok(body.includes("action:'checkinStatus'"));
 assert.ok(body.includes("action:'writeStatus'"));
 assert.ok(body.includes('recovery:true'));
 assert.ok(body.includes("if(!data.result?.ok) throw serverResponseError"));
});
test('photo and coordinates cannot be dropped by recovery',()=>{
 const sh=fakeSheet(),s=backend(sh);
 assert.throws(()=>s.saveCheckin_(sh,{...local(),inPhoto:'',recovery:true}),/Foto selfie/);
 assert.throws(()=>s.saveCheckin_(sh,{...local(),inGps:{lat:-6.5,lon:106.77},recovery:true}),/200 m/);
 assert.equal(sh.rows.length,1);
});
