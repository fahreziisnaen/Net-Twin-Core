# Spesifikasi: Pusat Log

Tanggal: 2026-09-30 · Status: menunggu review

## Tujuan

Saat ada masalah, admin bisa langsung melihat **apa yang terjadi, kapan, oleh siapa, dan dari mana** dari satu menu, tanpa membuka `docker logs`. Log dipisahkan per kategori sehingga analisa cepat.

Proyek ini juga menjadi fondasi bagi proyek berikutnya (Penerima Backup Config), yang mencatat setiap backup ke kategori **Backup Config**.

**Keputusan yang sudah disetujui**
- Cakupan: log **internal NetTwin** (aktivitas user serta sistem & integrasi). **Syslog perangkat tidak termasuk.**
- Menu Logs **hanya untuk admin**.

**Kriteria berhasil**
1. Setiap login (berhasil atau gagal), setiap perubahan data oleh user, setiap error server, dan setiap SSH Sync tercatat dengan kategori, level, pelaku, dan IP.
2. Admin dapat memfilter per kategori, level, waktu, user, dan teks, membuka detail entri (termasuk stack trace error), serta mengekspor CSV.
3. Menulis log tidak pernah memperlambat atau menggagalkan aksi user, termasuk saat database bermasalah.
4. Tidak ada password, secret, token, atau isi request mentah di log.
5. Semua yang dicatat tetap muncul di `docker logs` seperti sekarang.

## Model data

Satu entri log:

| Field | Keterangan |
|---|---|
| `id` | Nomor urut (naik); dipakai untuk paging |
| `ts` | Waktu (ISO 8601, milidetik) |
| `category` | `auth` · `activity` · `system` · `ssh` · `backup` |
| `level` | `info` · `warn` · `error` |
| `event` | Kode mesin, mis. `auth.login.failed`, `activity.request`, `system.save.failed` |
| `message` | Kalimat untuk manusia (maks. 1.000 karakter) |
| `actor` | Username pelaku, atau kosong (sistem / belum login) |
| `ip` | IP klien (mengikuti `TRUST_PROXY`) |
| `target` | Objek yang disentuh, mis. id device, id user, nama koneksi SSH |
| `details` | Objek JSON tambahan (maks. ±8 KB; stack trace dipotong bila lebih) |

## Apa yang dicatat

### Login & Akses (`auth`)
| Event | Level | Isi |
|---|---|---|
| Login berhasil | info | username, IP |
| Login gagal | warn | username yang dicoba (maks. 64 karakter), alasan: `password salah` / `user tidak ada` / `diblokir throttle` |
| Kode 2FA salah / challenge kedaluwarsa | warn | username, IP (setelah fitur 2FA terpasang) |
| Logout | info | username |
| 2FA diaktifkan / dimatikan / direset admin / kode cadangan dipakai | info | pelaku, target user, sisa kode cadangan |

### Aktivitas User (`activity`)
Dicatat **otomatis oleh middleware** untuk setiap request `POST`/`PUT`/`PATCH`/`DELETE` ke `/api/*`, kecuali login/logout (sudah masuk `auth`). Endpoint baru di masa depan otomatis ikut tercatat.

- Isi: pelaku, IP, **label ramah** dari tabel rute (mis. `PUT /api/twin/nodes/:id` → "Ubah device"), target (parameter `:id` pada rute), status HTTP, dan durasi.
- Level: `info` untuk 2xx, `warn` untuk 4xx (ditolak, bentrok, validasi), `error` untuk 5xx.
- Rute tanpa label memakai `METHOD path` apa adanya.
- **Isi request tidak disimpan.**

Aksi dengan dampak besar mendapat pesan khusus yang lebih jelas: factory reset, reset topology, import snapshot, apply change request, hapus user, dan ubah role.

### Sistem (`system`)
| Event | Level |
|---|---|
| Server start (versi, mode storage MySQL/file, `NODE_ENV`) | info |
| Server berhenti (SIGTERM/SIGINT) | info |
| Gagal menyimpan ke database (per penyimpan: twin / koneksi SSH / parser profile) | error |
| Penyimpanan pulih setelah gagal | info |
| MySQL belum siap saat start (retry) | warn |
| Peringatan konfigurasi: `JWT_SECRET` dev, SSH Sync nonaktif (`CRED_KEY`/`COLLECTOR_TOKEN` kosong) | warn / info |
| **Error server 500**: method, path, pelaku, pesan, **stack trace** | error |
| Pembersihan log (jumlah entri dihapus oleh retensi) | info |

### SSH Sync (`ssh`)
| Event | Level |
|---|---|
| Collect dimulai (pelaku, device, host, intents) | info |
| Collect berhasil (durasi, ringkasan drift) | info |
| Collect gagal (pesan error collector) | error |
| Host key dipin pertama kali / dipin ulang | info / warn |
| **Host key tidak cocok** | error |

### Backup Config (`backup`)
Kategori disiapkan sekarang, isinya diisi proyek Penerima Backup Config.

### Redaksi
Field bernama `password`, `secret`, `token`, `challenge`, `code`, `passwordHash`, `credential`, atau `authorization` (tanpa peduli huruf besar/kecil, termasuk di objek bertingkat) diganti `[redacted]` sebelum disimpan. Ini lapisan pengaman kedua; kode pencatat memang tidak memasukkan field tersebut.

## Penyimpanan

- **MySQL**: tabel baru
  ```sql
  CREATE TABLE IF NOT EXISTS app_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts DATETIME(3) NOT NULL,
    category VARCHAR(16) NOT NULL,
    level VARCHAR(8) NOT NULL,
    event VARCHAR(64) NOT NULL,
    actor VARCHAR(64) NULL,
    ip VARCHAR(64) NULL,
    target VARCHAR(255) NULL,
    message TEXT NOT NULL,
    details JSON NULL,
    INDEX idx_ts (ts),
    INDEX idx_category_ts (category, ts),
    INDEX idx_level_ts (level, ts)
  );
  ```
- **Mode file** (tanpa MySQL): `data/logs/app-YYYY-MM-DD.jsonl`, satu baris JSON per entri, satu file per hari (UTC).
- **Penulisan berkelompok**: entri masuk antrean di memori dan ditulis per ±1 detik (atau setiap 200 entri). Jika penulisan gagal, entri tetap di antrean (maksimal **5.000**; bila penuh, yang tertua dibuang dan jumlahnya dicatat sebagai satu entri `system` saat pulih). Setiap entri **selalu** juga dicetak ke stdout (`docker logs`).
- Saat server berhenti (SIGTERM), antrean log dikosongkan dulu bersama antrean penyimpanan lain.
- Entri yang dibuat sebelum storage siap (mis. retry MySQL saat start) ditahan lalu ditulis setelah storage siap.

## Retensi

- Default **90 hari**. Admin dapat mengubahnya di **Settings** (7–3650 hari).
- Pembersihan berjalan saat server start lalu setiap 24 jam; jumlah yang dihapus dicatat di `system`.
- **Factory Reset tidak menghapus log**; aksi factory reset itu sendiri tercatat.

## Akses (RBAC)

Aksi baru **`view-logs`** hanya dimiliki role **admin**. Operator dan viewer tidak melihat menu Logs, dan API log mengembalikan 403 untuk mereka.

## API

| Method & path | Isi |
|---|---|
| `GET /api/logs` | Query: `category`, `level` (boleh beberapa, dipisah koma), `from`, `to` (ISO), `actor`, `q` (cari di message/target/ip/event), `before` (id, untuk paging), `limit` (maks. 200, default 100) → `{ entries, nextBefore }`, terbaru dulu |
| `GET /api/logs/summary` | Query: `from`, `to`, `actor`, `q` → jumlah per kategori dan per level (untuk angka di tab) serta `errorsLast24h` (untuk badge sidebar) |
| `GET /api/logs/export` | Query sama dengan `GET /api/logs` → file CSV (maks. 50.000 baris, terbaru dulu) |
| `GET/PUT /api/twin/settings` | Menambah field `logRetentionDays` |

## Antarmuka

**Menu "Logs"** di sidebar, hanya untuk admin, dengan **badge merah** berisi jumlah error dalam 24 jam terakhir (diperbarui tiap 60 detik; tersembunyi bila 0).

- **Tab kategori** dengan jumlah entri sesuai filter: Semua · Login & Akses · Aktivitas User · Sistem · SSH Sync · Backup Config.
- **Filter**: level (Info / Warning / Error, bisa lebih dari satu), rentang waktu (1 jam · 24 jam · 7 hari · 30 hari · custom), user, dan kotak pencarian.
- **Tabel**: waktu (zona waktu browser), level berwarna, kategori, user, IP, pesan.
- **Klik baris** membuka panel detail: semua field, `details` dalam format JSON rapi, stack trace dalam blok monospace, dan tombol salin.
- **Live**: refresh otomatis tiap 10 detik selama aktif.
- **Muat lebih banyak**: paging 100 entri.
- **Export CSV** sesuai filter aktif.
- Teks tersedia dalam bahasa Inggris dan Indonesia.

**Settings**: isian "Simpan log selama (hari)" di kartu pengaturan engine.

## Penanganan error

| Situasi | Perilaku |
|---|---|
| Database log gagal ditulis | Aksi user tetap berhasil; entri ditahan di antrean dan dicoba lagi |
| Antrean penuh (> 5.000) | Entri tertua dibuang; saat pulih dicatat "N entri log hilang" |
| Filter tidak valid (tanggal rusak, kategori tak dikenal) | 400 dengan pesan jelas |
| Non-admin membuka API log | 403 |

## Pengujian

- **Unit**: antrean log (penulisan berkelompok, retry saat gagal, batas 5.000 dan pencatatan entri hilang, flush saat berhenti); redaksi field sensitif termasuk bertingkat; label rute; storage log di file (tulis, query filter, paging, retensi per file) dan MySQL (pool tiruan: DDL, insert batch, query berfilter, delete retensi); validasi query.
- **HTTP (build produksi)**: login gagal dan berhasil muncul di `auth`; membuat/mengubah/menghapus device muncul di `activity` dengan target yang benar; request ditolak (403/409) tercatat sebagai `warn`; error 500 tercatat di `system` dengan stack trace; tidak ada password di log mana pun (cek teks mentah); filter kategori/level/q/waktu dan paging berjalan; export CSV; viewer/operator mendapat 403; retensi yang diubah tersimpan.
- **Browser**: menu hanya muncul untuk admin, badge error, tab dan jumlahnya, filter, panel detail dengan stack trace, export, Live, dan tanpa dialog bawaan browser.

## Di luar cakupan

Syslog perangkat, log container MySQL/collector, pengiriman log ke sistem eksternal (SIEM/Loki), alert email/Telegram, dan grafik tren.
