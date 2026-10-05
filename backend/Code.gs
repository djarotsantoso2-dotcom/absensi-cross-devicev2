const APP_VERSION = '1.9.9';
const SHEET_NAME = 'Absensi';
const DEFAULT_NORMAL_OUT = '17:30';
const PRIMARY_SPREADSHEET_ID = '1yELZY2kInp3AiDx7jvQBpAlgWF238oGN-qfZlETS0YQ';

const HOST_EMAILS = Object.freeze([
  'djarotsantoso2@gmail.com',
  'suryowidiantoro682@gmail.com'
]);

function hostLabel_() {
  return HOST_EMAILS.join(' · ');
}

const DIVISION_STARTS = Object.freeze({
  ADMIN: '08:00',
  PACKING: '09:00',
  GUDANG: '09:00'
});

const WAREHOUSES = Object.freeze({
  KEBANDUNGAN: Object.freeze({name:'Kebandungan', lat:-6.633483, lon:106.775966, radiusM:200}),
  PARAKAN: Object.freeze({name:'Parakan', lat:-6.622239, lon:106.771941, radiusM:10}),
  CM: Object.freeze({name:'CM', lat:-6.6265, lon:106.7791667, radiusM:10}),
  NANAS: Object.freeze({name:'Nanas', lat:-6.618490474658237, lon:106.78478377021241, radiusM:200})
});

const HEADERS = [
  'ID','Karyawan','Divisi','Tanggal','Jam Masuk','Jadwal Masuk','Telat Menit',
  'Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Pekerjaan',
  'Jam Pulang','Lat Pulang','Lon Pulang','Akurasi Pulang','Lembur Jam',
  'Host','Status','Dibuat','Diubah','Gudang','Jobdesk Pulang'
];

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || 'health');
    let result;
    if (action === 'health') {
      result = {
        ok: true,
        service: 'Absensi Kamera GPS',
        version: APP_VERSION,
        capabilities: {writeStatus:true,checkoutWork:true},
        host: hostLabel_(),
        hosts: HOST_EMAILS,
        normalOut: getProp_('NORMAL_OUT', DEFAULT_NORMAL_OUT),
        schedules: DIVISION_STARTS,
        warehouses: WAREHOUSES,
        serverTime: new Date().toISOString()
      };
    } else if (action === 'today') {
      result = getToday_(p.employee, p.warehouse, p.date);
    } else if (action === 'writeStatus') {
      result = getWriteStatus_(p);
    } else if (action === 'weekSummary') {
      result = weekSummary_(p.employee, p.warehouse);
    } else {
      throw new Error('Action tidak dikenal');
    }
    return output_(result, p.callback || p.prefix || '');
  } catch (err) {
    return output_(
      {ok:false,error:String(err && err.message || err)},
      (e && e.parameter && (e.parameter.callback || e.parameter.prefix)) || ''
    );
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let acquired = false;
  let payload;
  let result;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!payload || !payload.type || !payload.record) throw new Error('Payload tidak valid');
    acquired = lock.tryLock(10000);
    if (!acquired) throw new Error('Server sedang sibuk. Tekan tombol absen lagi untuk mencoba kembali.');
    const sh = getSheet_();
    if (payload.type === 'checkin') result = saveCheckin_(sh, payload.record);
    else if (payload.type === 'checkout') result = saveCheckout_(sh, payload.record);
    else throw new Error('Tipe tidak dikenal');
    SpreadsheetApp.flush();
  } catch (err) {
    result = {ok:false,error:String(err && err.message || err)};
  } finally {
    if (acquired) {try { lock.releaseLock(); } catch (_) {}}
  }
  cacheWriteResult_(payload,result);
  return output_(result,'');
}

function writeResultKey_(requestId) {
  const id = String(requestId || '');
  return /^[A-Za-z0-9_-]{1,120}$/.test(id) ? 'absensi.write.'+id : '';
}

function cacheWriteResult_(payload,result) {
  const key = writeResultKey_(payload && payload.requestId);
  if (!key) return;
  // Confirmation is optional: a cache outage must not invalidate a completed write.
  try {
    const r = payload.record;
    CacheService.getScriptCache().put(key,JSON.stringify({employee:cleanName_(r.employee).toLowerCase(),warehouse:normalizeWarehouse_(r.warehouse),result:result}),600);
  } catch (_) {}
}

function getWriteStatus_(p) {
  const key = writeResultKey_(p.requestId);
  const name = cleanName_(p.employee).toLowerCase();
  const wh = normalizeWarehouse_(p.warehouse);
  if (!key || !name || !wh) throw new Error('Identitas permintaan tidak valid');
  let entry;
  try {entry = JSON.parse(CacheService.getScriptCache().get(key) || 'null');} catch (_) {}
  if (!entry) return {ok:true,pending:true};
  if (entry.employee !== name || entry.warehouse !== wh) throw new Error('Identitas konfirmasi tidak cocok');
  return {ok:true,pending:false,result:entry.result};
}

function saveCheckin_(sh, r) {
  const employee = cleanName_(r.employee);
  const division = normalizeDivision_(r.division);
  const warehouse = normalizeWarehouse_(r.warehouse);
  if (!employee) throw new Error('Nama karyawan wajib diisi');
  if (!division) throw new Error('Divisi wajib dipilih: Admin, Packing, atau Gudang');
  if (!warehouse) throw new Error('Gudang wajib dipilih: Kebandungan, Parakan, CM, atau Nanas');

  validateCheckinGeofence_(warehouse, r.inGps);

  const serverNow = new Date();
  const date = format_(serverNow, 'yyyy-MM-dd');
  const inLocal = format_(serverNow, 'HH:mm:ss');
  const existing = findRowByEmployeeDate_(sh, employee, date);
  if (existing) return {ok:false,duplicate:true,error:'Karyawan sudah absen hari ini',record:publicRecord_(sh, existing)};

  const id = String(r.id || Utilities.getUuid());
  const scheduledStart = DIVISION_STARTS[division];
  const lateMinutes = lateMinutes_(inLocal, scheduledStart);
  const photoUrl = r.inPhoto ? savePhoto_(r.inPhoto, `${safe_(warehouse)}_${safe_(employee)}_${date}_${safe_(id)}.jpg`) : '';

  sh.appendRow([
    id, employee, division, date, inLocal, scheduledStart, lateMinutes,
    val_(r.inGps,'lat'), val_(r.inGps,'lon'), val_(r.inGps,'accuracy'), photoUrl,
    String(r.work || '').trim(), '', '', '', '', 0,
    hostLabel_(), 'MASUK', serverNow, serverNow, warehouse, ''
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
  const warehouse = normalizeWarehouse_(r.warehouse);
  if (!employee || !warehouse || cleanName_(existing.employee).toLowerCase() !== employee.toLowerCase() || existing.warehouse !== warehouse || existing.date !== date) {
    throw new Error('Data absen masuk tidak cocok dengan karyawan, gudang, atau tanggal hari ini');
  }
  if (!r.outGps || !Number.isFinite(r.outGps.lat) || !Number.isFinite(r.outGps.lon) || Math.abs(r.outGps.lat) > 90 || Math.abs(r.outGps.lon) > 180) {
    throw new Error('Koordinat GPS pulang tidak valid');
  }
  if (existing.outLocal) return {ok:true,duplicate:true,record:existing};

  const checkoutWork = String(r.outWork || r.checkoutWork || '').trim().slice(0,1000);
  if (!checkoutWork) throw new Error('Jobdesk Pulang wajib diisi');

  const outLocal = format_(serverNow, 'HH:mm:ss');
  const normalOut = getProp_('NORMAL_OUT', DEFAULT_NORMAL_OUT);
  const overtime = overtimeHours_(existing.inLocal, outLocal, normalOut);

  sh.getRange(row,13,1,9).setValues([[
    outLocal,
    val_(r.outGps,'lat'), val_(r.outGps,'lon'), val_(r.outGps,'accuracy'),
    overtime,
    hostLabel_(), 'PULANG',
    sh.getRange(row,20).getValue() || serverNow,
    serverNow
  ]]);
  sh.getRange(row,23).setValue(checkoutWork);

  return {ok:true,row:row,record:publicRecord_(sh,row)};
}

function getToday_(employee, warehouse, requestedDate) {
  const name = cleanName_(employee);
  const wh = normalizeWarehouse_(warehouse);
  if (!name) throw new Error('Nama karyawan kosong');
  if (!wh) throw new Error('Gudang belum dipilih');
  const date = format_(new Date(),'yyyy-MM-dd');
  const sh = getSheet_();
  const row = findRowByEmployeeDateWarehouse_(sh, name, date, wh);
  return {ok:true,record:row ? publicRecord_(sh,row) : null};
}

function weekSummary_(employee, warehouse) {
  const name = cleanName_(employee);
  const wh = normalizeWarehouse_(warehouse);
  if (!name) throw new Error('Nama karyawan kosong');
  if (!wh) throw new Error('Gudang belum dipilih');

  const sh = getSheet_();
  const last = sh.getLastRow();
  if (last < 2) return {ok:true,days:0,overtime:0,lateMinutes:0};

  const values = sh.getRange(2,1,last-1,HEADERS.length).getValues();
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0,0,0,0);
  monday.setDate(monday.getDate() - ((monday.getDay()+6)%7));
  const start = format_(monday,'yyyy-MM-dd');

  const dates = {};
  let ot = 0;
  let late = 0;

  values.forEach(row => {
    if (String(row[1]).trim().toLowerCase() !== name.toLowerCase()) return;
    if (String(row[21] || '').trim().toUpperCase() !== wh) return;
    const d = String(row[3]);
    if (d < start) return;
    dates[d] = true;
    late += Number(row[6]) || 0;
    ot += Number(row[16]) || 0;
  });

  return {
    ok:true,
    days:Object.keys(dates).length,
    overtime:Math.round(ot*100)/100,
    lateMinutes:Math.round(late),
    weekStart:start
  };
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(PRIMARY_SPREADSHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  ensureHeader_(sh);
  return sh;
}

function ensureHeader_(sh) {
  const last = sh.getLastRow();
  const legacyHeaders = HEADERS.slice(0,21);

  if (last === 0) {
    sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
    return;
  }

  const legacyCurrent = sh.getRange(1,1,1,legacyHeaders.length).getDisplayValues()[0];
  const legacySame = legacyHeaders.every((h,i) => String(legacyCurrent[i] || '') === h);
  const currentWarehouseHeader = String(sh.getRange(1,22).getDisplayValue() || '');
  const currentCheckoutWorkHeader = String(sh.getRange(1,23).getDisplayValue() || '');

  if (legacySame && currentWarehouseHeader === 'Gudang' && currentCheckoutWorkHeader === 'Jobdesk Pulang') return;

  if (legacySame && currentWarehouseHeader === 'Gudang' && !currentCheckoutWorkHeader) {
    sh.getRange(1,23).setValue('Jobdesk Pulang');
    return;
  }

  if (legacySame && !currentWarehouseHeader) {
    sh.getRange(1,22,1,2).setValues([['Gudang','Jobdesk Pulang']]);
    return;
  }

  if (last <= 1) {
    sh.getRange(1,1,1,Math.max(sh.getLastColumn(),HEADERS.length)).clearContent();
    sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
    return;
  }

  throw new Error('Struktur sheet tidak dikenali. Backup data lalu periksa header sheet Absensi.');
}

function findRowById_(sh,id) {
  if (!id) return 0;
  const last = sh.getLastRow();
  if (last < 2) return 0;

  const match = sh.getRange(2,1,last-1,1).createTextFinder(id).matchEntireCell(true).matchCase(true).useRegularExpression(false).findNext();
  return match ? match.getRow() : 0;
}

function findRowByEmployeeDate_(sh,employee,date) {
  return findRecentEmployeeRow_(sh,employee,date,'');
}

function findRowByEmployeeDateWarehouse_(sh,employee,date,warehouse) {
  return findRecentEmployeeRow_(sh,employee,date,warehouse);
}

function findRecentEmployeeRow_(sh,employee,date,warehouse) {
  const n = cleanName_(employee).toLowerCase();
  const w = String(warehouse || '').trim().toUpperCase();
  // Most current-day rows are at the bottom. Stop without exporting the entire history.
  for (let end=sh.getLastRow();end>=2;) {
    const start = Math.max(2,end-249);
    const rows = sh.getRange(start,2,end-start+1,w ? 21 : 3).getValues();
    for (let i=rows.length-1;i>=0;i--) {
      if (cleanName_(rows[i][0]).toLowerCase() === n && dateKey_(rows[i][2]) === String(date) && (!w || String(rows[i][20] || '').trim().toUpperCase() === w)) return start+i;
    }
    end = start-1;
  }
  return 0;
}

function publicRecord_(sh,row) {
  const v = sh.getRange(row,1,1,HEADERS.length).getValues()[0];
  return {
    id:String(v[0]||''),
    employee:String(v[1]||''),
    warehouse:String(v[21]||''),
    division:String(v[2]||''),
    date:dateKey_(v[3]),
    inLocal:v[4] instanceof Date ? format_(v[4], 'HH:mm:ss') : String(v[4]||''),
    scheduledStart:String(v[5]||''),
    lateMinutes:Number(v[6])||0,
    work:String(v[11]||''),
    outLocal:v[12] instanceof Date ? format_(v[12], 'HH:mm:ss') : String(v[12]||''),
    overtime:Number(v[16])||0,
    status:String(v[18]||''),
    checkoutWork:String(v[22]||'')
  };
}

function normalizeDivision_(s) {
  const v = String(s || '').trim().toUpperCase();
  if (v === 'ADMIN') return 'ADMIN';
  if (v === 'PACKING') return 'PACKING';
  if (v === 'GUDANG') return 'GUDANG';
  return '';
}

function validateCheckinGeofence_(warehouse, gps) {
  const cfg = WAREHOUSES[warehouse];
  if (!cfg) throw new Error('Gudang tidak valid');
  if (!Number.isFinite(Number(cfg.lat)) || !Number.isFinite(Number(cfg.lon))) {
    throw new Error('Koordinat Gudang ' + cfg.name + ' belum dikonfigurasi. Absen masuk dikunci.');
  }

  const lat = Number(gps && gps.lat);
  const lon = Number(gps && gps.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('GPS wajib aktif untuk absen masuk');
  }

  const distance = distanceMeters_(lat, lon, Number(cfg.lat), Number(cfg.lon));
  if (distance > Number(cfg.radiusM || 10)) {
    throw new Error(
      'Absen masuk ditolak. Jarak dari Gudang ' + cfg.name + ': ' +
      distance.toFixed(1) + ' m. Batas maksimal ' + Number(cfg.radiusM || 10) + ' m.'
    );
  }
  return distance;
}

function distanceMeters_(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeWarehouse_(s) {
  const v = String(s || '').trim().toUpperCase();
  return WAREHOUSES[v] ? v : '';
}

function lateMinutes_(actual, scheduled) {
  const a = minutesFromClock_(actual);
  const s = minutesFromClock_(scheduled);
  if (a == null || s == null) return 0;
  return Math.max(0, a - s);
}

function overtimeHours_(inLocal, outLocal, normalOut) {
  const inMin = minutesFromClock_(inLocal);
  const outMin = minutesFromClock_(outLocal);
  const normalMin = minutesFromClock_(normalOut);

  if (inMin == null || outMin == null || normalMin == null) return 0;
  if (inMin >= normalMin) return 0;
  if (outMin <= normalMin) return 0;

  return Math.round(((outMin - normalMin) / 60) * 100) / 100;
}

function minutesFromClock_(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;

  const h = parts[0];
  const m = parts[1];

  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function savePhoto_(dataUrl,name) {
  const folderId = getProp_('PHOTO_FOLDER_ID','');
  if (!folderId) throw new Error('Script Property PHOTO_FOLDER_ID belum diisi');

  const m = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) throw new Error('Format foto tidak valid');

  const blob = Utilities.newBlob(
    Utilities.base64Decode(m[2]),
    m[1],
    name
  );

  return DriveApp.getFolderById(folderId).createFile(blob).getUrl();
}

function getProp_(key, fallback) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value == null || value === '' ? fallback : value;
}

function dateKey_(value) {
  return value instanceof Date ? format_(value, 'yyyy-MM-dd') : String(value || '').trim();
}

function cleanName_(s) {
  return String(s||'').replace(/\s+/g,' ').trim().slice(0,80);
}

function safe_(s) {
  return String(s||'x').replace(/[^a-z0-9_-]+/gi,'_').slice(0,80);
}

function val_(o,k) {
  return o && o[k] != null ? o[k] : '';
}

function format_(d,pattern) {
  return Utilities.formatDate(
    d,
    'Asia/Jakarta',
    pattern
  );
}

function output_(obj, callback) {
  const json = JSON.stringify(obj);
  const cb = String(callback||'');

  if (cb && /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(cb)) {
    return ContentService
      .createTextOutput(cb+'('+json+')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
