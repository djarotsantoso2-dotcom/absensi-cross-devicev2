const APP_VERSION = '1.9.4';
const SHEET_NAME = 'Absensi';
const DEFAULT_NORMAL_OUT = '17:30';

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
  KEBANDUNGAN: Object.freeze({name:'Kebandungan', lat:-6.6335959, lon:106.7761478, radiusM:10}),
  PARAKAN: Object.freeze({name:'Parakan', lat:-6.622239, lon:106.771941, radiusM:10}),
  CM: Object.freeze({name:'CM', lat:-6.6264890, lon:106.7792440, radiusM:10}),
  NANAS: Object.freeze({name:'Nanas', lat:-6.618239, lon:106.784676, radiusM:10})
});

const HEADERS = [
  'ID','Karyawan','Divisi','Tanggal','Jam Masuk','Jadwal Masuk','Telat Menit',
  'Lat Masuk','Lon Masuk','Akurasi Masuk','Foto','Pekerjaan',
  'Jam Pulang','Lat Pulang','Lon Pulang','Akurasi Pulang','Lembur Jam',
  'Host','Status','Dibuat','Diubah','Gudang'
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
        host: hostLabel_(),
        hosts: HOST_EMAILS,
        normalOut: getProp_('NORMAL_OUT', DEFAULT_NORMAL_OUT),
        schedules: DIVISION_STARTS,
        warehouses: WAREHOUSES,
        serverTime: new Date().toISOString()
      };
    } else if (action === 'today') {
      result = getToday_(p.employee, p.warehouse, p.date);
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
    hostLabel_(), 'MASUK', serverNow, serverNow, warehouse
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
  const spreadsheetId = getProp_('SPREADSHEET_ID','');
  if (!spreadsheetId) throw new Error('Script Property SPREADSHEET_ID belum diisi');

  const ss = SpreadsheetApp.openById(spreadsheetId);
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

  if (legacySame && currentWarehouseHeader === 'Gudang') return;

  if (legacySame && !currentWarehouseHeader) {
    sh.getRange(1,22).setValue('Gudang');
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

  const ids = sh.getRange(2,1,last-1,1).getDisplayValues();
  for (let i=0;i<ids.length;i++) {
    if (String(ids[i][0]) === id) return i+2;
  }
  return 0;
}

function findRowByEmployeeDate_(sh,employee,date) {
  const last = sh.getLastRow();
  if (last < 2) return 0;

  const rows = sh.getRange(2,2,last-1,3).getDisplayValues();
  const n = String(employee).trim().toLowerCase();

  for (let i=0;i<rows.length;i++) {
    if (
      String(rows[i][0]).trim().toLowerCase() === n &&
      String(rows[i][2]) === String(date)
    ) return i+2;
  }
  return 0;
}

function findRowByEmployeeDateWarehouse_(sh,employee,date,warehouse) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const rows = sh.getRange(2,2,last-1,21).getDisplayValues();
  const n = String(employee).trim().toLowerCase();
  const w = String(warehouse).trim().toUpperCase();
  for (let i=0;i<rows.length;i++) {
    if (
      String(rows[i][0]).trim().toLowerCase() === n &&
      String(rows[i][2]) === String(date) &&
      String(rows[i][20] || '').trim().toUpperCase() === w
    ) return i+2;
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
    date:String(v[3]||''),
    inLocal:String(v[4]||''),
    scheduledStart:String(v[5]||''),
    lateMinutes:Number(v[6])||0,
    work:String(v[11]||''),
    outLocal:String(v[12]||''),
    overtime:Number(v[16])||0,
    status:String(v[18]||'')
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
    Session.getScriptTimeZone() || 'Asia/Jakarta',
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
