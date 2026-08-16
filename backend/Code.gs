const APP_VERSION = '1.5.0';
const SHEET_NAME = 'Absensi';
const DEFAULT_NORMAL_OUT = '19:00';

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || 'health');
    let result;
    if (action === 'health') result = {ok:true, service:'Absensi Kamera GPS', version:APP_VERSION, host:getProp_('HOST_EMAIL',''), serverTime:new Date().toISOString()};
    else if (action === 'today') result = getToday_(p.employee, p.date);
    else if (action === 'weekSummary') result = weekSummary_(p.employee);
    else throw new Error('Action tidak dikenal');
    return output_(result, p.callback || p.prefix || '');
  } catch (err) {
    return output_({ok:false,error:String(err && err.message || err)}, (e && e.parameter && (e.parameter.callback || e.parameter.prefix)) || '');
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!payload || !payload.type || !payload.record) throw new Error('Payload tidak valid');
    const sh = getSheet_();
    if (payload.type === 'checkin') return output_(saveCheckin_(sh, payload.record), '');
    if (payload.type === 'checkout') return output_(saveCheckout_(sh, payload.record), '');
    throw new Error('Tipe tidak dikenal');
  } catch (err) {
    return output_({ok:false,error:String(err && err.message || err)}, '');
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function saveCheckin_(sh, r) {
  const employee = cleanName_(r.employee);
  if (!employee) throw new Error('Nama karyawan wajib diisi');
  const serverNow = new Date();
  const date = format_(serverNow, 'yyyy-MM-dd');
  const inLocal = format_(serverNow, 'HH:mm:ss');
  const existing = findRowByEmployeeDate_(sh, employee, date);
  if (existing) return {ok:false,duplicate:true,error:'Karyawan sudah absen hari ini',record:publicRecord_(sh, existing)};

  const id = String(r.id || Utilities.getUuid());
  const photoUrl = r.inPhoto ? savePhoto_(r.inPhoto, `${safe_(employee)}_${date}_${safe_(id)}.jpg`) : '';
  sh.appendRow([
    id, employee, date, inLocal,
    val_(r.inGps,'lat'), val_(r.inGps,'lon'), val_(r.inGps,'accuracy'), photoUrl,
    String(r.work || '').trim(), '', '', '', '', 0,
    getProp_('HOST_EMAIL',''), 'MASUK', serverNow, serverNow
  ]);
  return {ok:true,row:sh.getLastRow(),record:publicRecord_(sh, sh.getLastRow())};
}

function saveCheckout_(sh, r) {
  const employee = cleanName_(r.employee);
  const serverNow = new Date();
  const date = format_(serverNow, 'yyyy-MM-dd');
  let row = findRowById_(sh, String(r.id || ''));
  if (!row && employee) row = findRowByEmployeeDate_(sh, employee, date);
  if (!row) throw new Error('Data absen masuk hari ini tidak ditemukan');

  const existing = publicRecord_(sh, row);
  if (existing.outLocal) return {ok:true,duplicate:true,record:existing};

  const outLocal = format_(serverNow, 'HH:mm:ss');
  const overtime = overtimeHours_(serverNow, getProp_('NORMAL_OUT', DEFAULT_NORMAL_OUT));
  sh.getRange(row,10,1,9).setValues([[
    outLocal, val_(r.outGps,'lat'), val_(r.outGps,'lon'), val_(r.outGps,'accuracy'),
    overtime, getProp_('HOST_EMAIL',''), 'PULANG', sh.getRange(row,17).getValue() || serverNow, serverNow
  ]]);
  return {ok:true,row:row,record:publicRecord_(sh,row)};
}

function getToday_(employee, requestedDate) {
  const name = cleanName_(employee);
  if (!name) throw new Error('Nama karyawan kosong');
  // Status hari ini selalu memakai tanggal server untuk mencegah manipulasi tanggal device.
  const date = format_(new Date(),'yyyy-MM-dd');
  const sh = getSheet_();
  const row = findRowByEmployeeDate_(sh, name, date);
  return {ok:true,record:row ? publicRecord_(sh,row) : null};
}

function weekSummary_(employee) {
  const name = cleanName_(employee);
  if (!name) throw new Error('Nama karyawan kosong');
  const sh = getSheet_();
  const last = sh.getLastRow();
  if (last < 2) return {ok:true,days:0,overtime:0};
  const values = sh.getRange(2,1,last-1,18).getValues();
  const now = new Date();
  const monday = new Date(now); monday.setHours(0,0,0,0); monday.setDate(monday.getDate() - ((monday.getDay()+6)%7));
  const start = format_(monday,'yyyy-MM-dd');
  const dates = {};
  let ot = 0;
  values.forEach(row=>{
    if (String(row[1]).trim().toLowerCase() !== name.toLowerCase()) return;
    const d = String(row[2]); if (d < start) return;
    dates[d] = true; ot += Number(row[13]) || 0;
  });
  return {ok:true,days:Object.keys(dates).length,overtime:Math.round(ot*100)/100,weekStart:start};
}

function getSheet_() {
  const spreadsheetId = getProp_('SPREADSHEET_ID','');
  if (!spreadsheetId) throw new Error('Script Property SPREADSHEET_ID belum diisi');
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  ensureHeader_(sh);
  return sh;
}

function ensureHeader_(sh) {
  const headers = ['ID','Karyawan','Tanggal','Jam Masuk','Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Pekerjaan','Jam Pulang','Lat Pulang','Lon Pulang','Akurasi Pulang','Lembur Jam','Host','Status','Dibuat','Diubah'];
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  else if (!String(sh.getRange(1,1).getValue()).trim()) sh.getRange(1,1,1,headers.length).setValues([headers]);
}

function findRowById_(sh,id) {
  if (!id) return 0;
  const last=sh.getLastRow(); if(last<2) return 0;
  const ids=sh.getRange(2,1,last-1,1).getDisplayValues();
  for(let i=0;i<ids.length;i++) if(String(ids[i][0])===id) return i+2;
  return 0;
}

function findRowByEmployeeDate_(sh,employee,date) {
  const last=sh.getLastRow(); if(last<2) return 0;
  const rows=sh.getRange(2,2,last-1,2).getDisplayValues();
  const n=String(employee).trim().toLowerCase();
  for(let i=0;i<rows.length;i++) if(String(rows[i][0]).trim().toLowerCase()===n && String(rows[i][1])===String(date)) return i+2;
  return 0;
}

function publicRecord_(sh,row) {
  const v=sh.getRange(row,1,1,18).getValues()[0];
  return {id:String(v[0]||''),employee:String(v[1]||''),date:String(v[2]||''),inLocal:String(v[3]||''),work:String(v[8]||''),outLocal:String(v[9]||''),overtime:Number(v[13])||0,status:String(v[15]||'')};
}

function overtimeHours_(now, normalOut) {
  const parts=String(normalOut||DEFAULT_NORMAL_OUT).split(':').map(Number);
  const normal=new Date(now); normal.setHours(parts[0]||0, parts[1]||0, 0, 0);
  return Math.round(Math.max(0,(now-normal)/3600000)*100)/100;
}

function savePhoto_(dataUrl,name) {
  const folderId=getProp_('PHOTO_FOLDER_ID','');
  if (!folderId) throw new Error('Script Property PHOTO_FOLDER_ID belum diisi');
  const m=String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
  if(!m) throw new Error('Format foto tidak valid');
  const blob=Utilities.newBlob(Utilities.base64Decode(m[2]),m[1],name);
  return DriveApp.getFolderById(folderId).createFile(blob).getUrl();
}

function getProp_(key, fallback) { const value=PropertiesService.getScriptProperties().getProperty(key); return value == null || value === '' ? fallback : value; }
function cleanName_(s){return String(s||'').replace(/\s+/g,' ').trim().slice(0,80);}
function safe_(s){return String(s||'x').replace(/[^a-z0-9_-]+/gi,'_').slice(0,80);}
function val_(o,k){return o && o[k]!=null ? o[k] : '';}
function format_(d,pattern){return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Jakarta', pattern);}

function output_(obj, callback) {
  const json=JSON.stringify(obj);
  const cb=String(callback||'');
  if (cb && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(cb)) return ContentService.createTextOutput(cb+'('+json+')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
