window.ABSENSI_CONFIG = Object.freeze({
  GAS_ENDPOINT: 'https://script.google.com/macros/s/AKfycbySsGCmwVJ8zNW9UjtmnTCU3HieSsG7JN7atUwahIkbX4_zt0rMC88JDDD1ztR-N_6R/exec',
  HOST_LABEL: 'djarotsantoso2@gmail.com · suryowidiantoro682@gmail.com',
  HOSTS: Object.freeze([
    'djarotsantoso2@gmail.com',
    'suryowidiantoro682@gmail.com'
  ]),
  APP_VERSION: '1.9.4',
  WAREHOUSES: Object.freeze({
    KEBANDUNGAN: Object.freeze({NAME:'Kebandungan', LAT:-6.633483, LON:106.775966, RADIUS_M:10}),
    PARAKAN: Object.freeze({NAME:'Parakan', LAT:-6.622239, LON:106.771941, RADIUS_M:10}),
    CM: Object.freeze({NAME:'CM', LAT:-6.6265, LON:106.7791667, RADIUS_M:10}),
    NANAS: Object.freeze({NAME:'Nanas', LAT:-6.618239, LON:106.784676, RADIUS_M:10})
  })
});

/*
 * Geofence button lock v1.9.3
 * Tombol ABSEN MASUK tidak dapat diklik sebelum GPS terverifikasi
 * berada di dalam radius gudang yang sedang dipilih.
 */
(function installGeofenceButtonLock(){
  const CFG = window.ABSENSI_CONFIG || {};
  const WAREHOUSES = CFG.WAREHOUSES || {};
  const KEY_WAREHOUSE = 'absensi.warehouse';
  let lastWarehouse = '';
  let lastPosition = null;
  let watchId = null;

  function $(id){ return document.getElementById(id); }
  function currentWarehouse(){
    return String(localStorage.getItem(KEY_WAREHOUSE) || '').trim().toUpperCase();
  }
  function currentConfig(){
    return WAREHOUSES[currentWarehouse()] || null;
  }
  function toRad(v){ return v * Math.PI / 180; }
  function distanceMeters(lat1, lon1, lat2, lon2){
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat/2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function setLocked(message, detail){
    const btn = $('checkIn');
    if(!btn) return;

    if(!btn.dataset.geoOriginalText){
      btn.dataset.geoOriginalText = btn.textContent || 'ABSEN MASUK';
    }

    btn.classList.add('geo-locked');
    btn.setAttribute('aria-disabled','true');
    btn.dataset.geoLocked = '1';
    btn.textContent = message || 'ABSEN MASUK TERKUNCI';

    const state = $('gpsState');
    if(state && detail){
      state.innerHTML = '<span class="pill bad">Absen masuk terkunci</span><br>' + detail;
    }
  }

  function setUnlocked(detail){
    const btn = $('checkIn');
    if(!btn) return;

    btn.classList.remove('geo-locked');
    btn.removeAttribute('aria-disabled');
    btn.dataset.geoLocked = '0';
    btn.textContent = btn.dataset.geoOriginalText || 'ABSEN MASUK';

    const state = $('gpsState');
    if(state && detail){
      state.innerHTML = '<span class="pill ok">Dalam area absen</span><br>' + detail;
    }
  }

  function evaluatePosition(pos){
    const cfg = currentConfig();
    const code = currentWarehouse();

    if(!code){
      setLocked('PILIH GUDANG DAHULU','Pilih gudang untuk memverifikasi lokasi.');
      return;
    }

    if(!cfg || !Number.isFinite(Number(cfg.LAT)) || !Number.isFinite(Number(cfg.LON))){
      setLocked('LOKASI GUDANG BELUM TERSEDIA','Koordinat gudang belum dikonfigurasi.');
      return;
    }

    if(!pos || !pos.coords){
      setLocked('MENUNGGU GPS...','Aktifkan GPS/lokasi presisi. Tombol akan aktif otomatis saat posisi terverifikasi.');
      return;
    }

    const lat = Number(pos.coords.latitude);
    const lon = Number(pos.coords.longitude);
    const accuracy = Number(pos.coords.accuracy || 0);
    const radius = Number(cfg.RADIUS_M || 10);
    const dist = distanceMeters(lat, lon, Number(cfg.LAT), Number(cfg.LON));

    const detail =
      'Gudang ' + cfg.NAME +
      ' · Jarak ' + dist.toFixed(1) + ' m / batas ' + radius + ' m' +
      ' · Akurasi GPS ' + Math.round(accuracy) + ' m';

    if(dist <= radius){
      setUnlocked(detail);
    }else{
      setLocked('DI LUAR AREA · ABSEN TERKUNCI', detail);
    }
  }

  function startWatching(){
    if(!navigator.geolocation){
      setLocked('GPS TIDAK TERSEDIA','Perangkat/browser tidak menyediakan GPS.');
      return;
    }

    if(watchId !== null) return;

    setLocked('MENUNGGU GPS...','Memverifikasi posisi terhadap gudang yang dipilih.');

    watchId = navigator.geolocation.watchPosition(
      pos => {
        lastPosition = pos;
        evaluatePosition(pos);
      },
      err => {
        lastPosition = null;
        setLocked(
          'IZIN GPS DIPERLUKAN',
          'Lokasi tidak dapat diverifikasi: ' + (err && err.message ? err.message : 'izin lokasi tidak tersedia') + '.'
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000
      }
    );
  }

  function installStyles(){
    if(document.getElementById('geo-lock-style')) return;
    const style = document.createElement('style');
    style.id = 'geo-lock-style';
    style.textContent = `
      #checkIn.geo-locked{
        pointer-events:none !important;
        cursor:not-allowed !important;
        opacity:.42 !important;
        filter:grayscale(.45);
        box-shadow:none !important;
        transform:none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function hardBlockClicks(){
    document.addEventListener('click', function(e){
      const btn = e.target && e.target.closest ? e.target.closest('#checkIn') : null;
      if(btn && btn.dataset.geoLocked === '1'){
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
      }
    }, true);
  }

  function warehouseWatcher(){
    const now = currentWarehouse();
    if(now !== lastWarehouse){
      lastWarehouse = now;
      evaluatePosition(lastPosition);
    }
  }

  function boot(){
    installStyles();
    hardBlockClicks();
    startWatching();
    evaluatePosition(lastPosition);
    setInterval(warehouseWatcher, 500);

    document.querySelectorAll('[data-warehouse]').forEach(btn => {
      btn.addEventListener('click', () => {
        setTimeout(() => {
          lastWarehouse = currentWarehouse();
          evaluatePosition(lastPosition);
        }, 50);
      });
    });

    const switchBtn = document.getElementById('switchWarehouse');
    if(switchBtn){
      switchBtn.addEventListener('click', () => {
        setTimeout(() => evaluatePosition(lastPosition), 50);
      });
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot, {once:true});
  }else{
    boot();
  }
})();
