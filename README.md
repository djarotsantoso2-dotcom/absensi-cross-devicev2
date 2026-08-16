# Absensi Kamera + GPS — Cross Device

Versi: **1.5.0**

Aplikasi absensi berbasis web/PWA untuk Android, iPhone/iPad, Windows, dan macOS. Frontend statis dapat di-host lewat GitHub Pages/Netlify/Vercel, sedangkan database pusat menggunakan Google Apps Script + Google Sheets + Google Drive.

## Perubahan utama v1.5

- Pembatasan **1 kali absen per karyawan per hari dilakukan di server** dengan `LockService`, sehingga tidak bisa dilewati hanya dengan ganti device/browser.
- Checkout bisa dilanjutkan dari device lain karena aplikasi membaca status absen hari ini dari server.
- Selfie kamera depan dapat diambil otomatis ketika **ABSEN MASUK** ditekan.
- GPS diminta saat masuk dan diminta ulang saat pulang.
- Jam masuk, jam pulang, dan lembur memakai waktu server; lembur tidak menerima angka manual dari karyawan.
- Ringkasan jumlah hari dan jam lembur mingguan dapat dibaca dari server pusat.
- PWA memiliki manifest + service worker agar dapat dipasang seperti aplikasi.

## Struktur repository

- `web/` — frontend PWA yang di-deploy ke hosting HTTPS.
- `backend/Code.gs` — backend Google Apps Script.
- `.github/workflows/pages.yml` — deploy otomatis `web/` ke GitHub Pages.
- `netlify.toml` — konfigurasi deploy folder `web/` di Netlify.

## 1. Siapkan backend Google Apps Script

1. Buka Google Apps Script menggunakan akun host.
2. Buat project baru dan tempel isi `backend/Code.gs`.
3. Project Settings → set timezone ke **Asia/Jakarta**.
4. Project Settings → Script Properties, tambahkan:
   - `SPREADSHEET_ID` = ID Google Sheet pusat.
   - `PHOTO_FOLDER_ID` = ID folder Google Drive untuk foto selfie.
   - `HOST_EMAIL` = email host.
   - `NORMAL_OUT` = contoh `19:00`.
5. Deploy → New deployment → **Web app**.
6. Execute as: **Me**. Access: **Anyone**.
7. Salin URL yang berakhir `/exec`.

## 2. Hubungkan frontend ke backend

Edit `web/config.js` lalu isi:

```js
GAS_ENDPOINT: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec'
```

Dengan cara ini semua device otomatis memakai backend yang sama. Kolom URL server di Dashboard tetap tersedia sebagai override lokal untuk pengujian.

## 3. Deploy GitHub Pages

Workflow sudah tersedia di `.github/workflows/pages.yml`. Setelah repository berada di GitHub:

1. Settings → Pages.
2. Source: **GitHub Actions**.
3. Push ke branch `main`.
4. Workflow akan upload folder `web/` dan menghasilkan URL HTTPS.

> Kamera dan GPS browser membutuhkan HTTPS agar dapat berfungsi normal di perangkat pengguna.

## 4. Install di device

- Android/Chrome: buka URL → menu browser → **Install app / Add to Home screen**.
- iPhone/iPad/Safari: Share → **Add to Home Screen**.
- Windows/Chrome atau Edge: buka URL → ikon **Install app** di address bar/menu.

## Catatan keamanan

Untuk repository publik, jangan memasukkan credential, token, atau password. ID Spreadsheet/Folder dan pengaturan host disimpan sebagai Script Properties pada Google Apps Script, bukan di repository.
