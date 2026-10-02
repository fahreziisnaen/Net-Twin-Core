# Spesifikasi: Penerima Backup Config Harian

Tanggal: 2026-10-02 · Status: menunggu review · Bergantung pada: [Pusat Log](2026-09-30-log-center-design.md)

## Tujuan

Perangkat jaringan mengirim backup konfigurasinya sendiri setiap hari ke NetTwin. NetTwin **menyimpan setiap versi** (riwayat dan diff) lalu **langsung memperbarui device di twin**, sehingga twin selalu mengikuti kondisi perangkat tanpa import manual. Jika ada masalah, admin bisa melihat apa yang berubah dan kapan.

**Keputusan yang sudah disetujui**
- Penerima **SFTP/SCP dan FTP/TFTP sekaligus**, dijalankan di **container sidecar terpisah** (`receiver`).
- **Akun backup per perangkat**, dikelola admin di UI.
- Device yang belum dikenal **ditahan**; admin memilih untuk membuat device baru atau menghubungkannya ke device yang ada.
- Penerapan ke twin bersifat **sinkron**: entri yang berasal dari backup diganti setiap ada backup baru, sehingga yang dihapus di perangkat ikut hilang. Entri manual dan route hasil SSH Sync tetap aman.
- Menu hanya untuk **admin**. Semua kejadian dicatat di kategori **Backup Config** Pusat Log.

**Kriteria berhasil**
1. Backup dari Cisco IOS, Junos, FortiGate, PAN-OS, dan ScreenOS yang dikirim lewat protokol yang didukung perangkatnya diterima, dikenali, disimpan, dan diterapkan ke twin tanpa campur tangan admin.
2. Route/rule/NAT yang dihapus di perangkat ikut hilang dari twin pada backup berikutnya; entri manual tidak tersentuh.
3. Admin dapat melihat riwayat versi per device, membandingkan dua versi (diff), mengunduh file asli, dan menerapkan versi lama ke twin.
4. Backup yang salah kirim (akun device A, isi config device B yang ada di twin) tidak pernah menimpa device A.
5. Device yang berhenti mengirim backup lebih dari 26 jam terlihat di menu dan di Pusat Log.
6. Receiver hanya bisa menerima upload: tidak bisa download, list, hapus, atau membuka shell.

## Arsitektur

```
perangkat ──SFTP/SCP :2222──┐
perangkat ──FTP :21 (+PASV)─┼─► receiver (Python) ──HTTP internal :3001 + RECEIVER_TOKEN──► app ──► MySQL
perangkat ──TFTP :69/udp────┘      │ spool + cache akun (volume receiver_data)
                                   ◄── daftar akun (hash) tiap 60 dtk (heartbeat) ──
```

- **receiver**: menerima file, memeriksa login/IP/ukuran, menyimpan file ke spool, lalu meneruskannya ke app. Receiver **tidak punya akses database** dan tidak memegang `JWT_SECRET`.
- **app**: membuka file, mengonversi format, mengenali device, menyimpan versi, menerapkan ke twin, dan mencatat log.
- **Port internal app `3001`** hanya menerima rute `/internal/receiver/*`, wajib membawa token, dan **tidak dipublikasikan** di compose. Port publik `3000` tidak melayani rute internal.

## Container `receiver`

**Protokol dan port** (di dalam container memakai port tinggi; compose memetakannya)

| Protokol | Port host (default) | Dipakai oleh |
|---|---|---|
| SFTP + SCP (asyncssh) | `2222/tcp` | Cisco `archive` (scp), Junos `archival` (scp), PAN-OS (scp), FortiGate (sftp) |
| FTP (pyftpdlib) | `21/tcp` + passive `30000–30009/tcp` | Vendor yang mendukung FTP |
| TFTP (khusus tulis, RFC 1350) | `69/udp` | ScreenOS dan perangkat lama |

**Aturan keamanan**
- **Hanya upload.** SFTP: hanya `open` untuk tulis, `close`, `rename` atas file yang di-upload di sesi yang sama, `stat`/`realpath`; listing selalu kosong. SCP: hanya mode sink (`scp -t`). Tidak ada shell, exec lain, atau port forwarding. FTP: izin tulis saja (STOR), listing kosong, tanpa RETR/DELE/RNFR/MKD. TFTP: hanya WRQ; RRQ dijawab "Access violation".
- **Login per akun** (SFTP/SCP/FTP). Password diverifikasi dengan hash bcrypt dari cache akun.
- **TFTP tanpa login**: hanya diterima dari IP yang terdaftar di **IP perangkat** pada akun yang aktif.
- **Allowlist jaringan** `BACKUP_ALLOWED_NETS` (default `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`) berlaku untuk semua protokol. Jika akun punya daftar IP perangkat, login akun itu hanya diterima dari IP tersebut.
- **Throttle**: 10 kegagalan login per IP per 15 menit.
- **Batas ukuran**: `BACKUP_MAX_BYTES` (default 20 MB) per file; upload yang melewati batas dibatalkan.
- **Host key SSH** (ed25519 dan RSA 3072) dibuat sekali lalu disimpan di volume. Algoritma lama (`ssh-rsa`, `diffie-hellman-group14-sha1`) diizinkan demi kompatibilitas IOS lama. Fingerprint SHA256 dilaporkan ke app.
- Nama file dari perangkat hanya dipakai sebagai label (basename, karakter aman, maks. 255). File disimpan di spool dengan nama acak.

**Penerusan ke app**
- File yang selesai diterima diteruskan ke `POST /internal/receiver/uploads` dengan `uploadId` unik, sehingga pengiriman ulang tidak tercatat dua kali.
- Gagal kirim akan dicoba lagi dengan jeda bertahap (maks. 5 menit). File baru dihapus dari spool setelah app menjawab sukses.
- Spool dibatasi 1 GB; saat penuh, upload baru ditolak dan kejadiannya dilaporkan.

**Heartbeat**: setiap 60 detik receiver mengirim status (protokol aktif, port, fingerprint host key, jumlah file di spool) dan menerima **daftar akun terbaru** (username, hash password, IP perangkat, status aktif). Daftar akun disimpan di volume, sehingga login tetap berjalan saat app restart.

**Kejadian keamanan** (IP ditolak, login gagal, terlalu besar, spool penuh, RRQ TFTP) dikirim berkelompok ke `POST /internal/receiver/events` dan dicatat sebagai `warn` di kategori Backup Config.

**Konfigurasi (.env)**

| Variabel | Default | Keterangan |
|---|---|---|
| `RECEIVER_TOKEN` | kosong = fitur nonaktif | Secret bersama app ↔ receiver, ≥ 16 karakter |
| `BACKUP_PROTOCOLS` | `sftp,ftp,tftp` | Protokol yang aktif |
| `BACKUP_PUBLIC_HOST` | kosong | IP LAN server yang dituju perangkat; dipakai untuk balasan FTP passive dan Panduan Setup |
| `BACKUP_ALLOWED_NETS` | jaringan privat | CIDR yang boleh mengirim |
| `BACKUP_MAX_BYTES` | `20971520` | Batas ukuran file |
| `BACKUP_SFTP_PORT` / `BACKUP_FTP_PORT` / `BACKUP_TFTP_PORT` | `2222` / `21` / `69` | Port di host |

**Catatan NAT Docker**: FTP passive butuh `BACKUP_PUBLIC_HOST` dan rentang port passive yang dipublikasikan 1:1. TFTP membalas dari port acak dan mengandalkan conntrack Docker. Bila perangkat tidak menerima balasan TFTP, gunakan `network_mode: host` untuk receiver (didokumentasikan sebagai alternatif). Keduanya harus diverifikasi saat deploy.

## Pemrosesan di app

1. **Buka file**: gzip (`1f 8b`) didekompresi; tar/tgz dicari `running-config.xml`, lalu file `.xml`/`.conf`/`.cfg` pertama. Teks: UTF-8 dengan cadangan Latin-1, BOM dan NUL dibuang, baris baru diseragamkan. Batas teks hasil 10 MB.
2. **Konversi format** (juga dipasang di Config Importer):
   - **Junos kurung kurawal → `set`**: menangani komentar `#` dan `/* */`, `inactive:` (dilewati), string berkutip, daftar `[ a b ]`, dan anotasi `## Last commit`.
   - **PAN-OS XML → `set`**: elemen `entry name="…"` menjadi nama, `member` menjadi daftar, `config/devices/entry/vsys/entry` menjadi path `set` yang dikenali parser.
3. **Deteksi vendor** dengan profil parser yang ada, lalu parse. Jika vendor tidak dikenali atau hasil parse kosong, status menjadi **gagal parse** (versi tetap disimpan dan dicatat error), dan twin tidak disentuh.
4. **Kenali device**, berhenti di aturan pertama yang cocok:
   1. akun yang dipakai, jika terhubung ke device yang masih ada;
   2. TFTP: IP sumber → akun → device terhubung;
   3. hostname di config → **alias** yang pernah dipilih admin;
   4. hostname di config → device dengan nama/id sama (tanpa peduli huruf besar/kecil dan aksen);
   5. tidak ada yang cocok → **Perlu Tindakan: belum dikenal**.

   **Pengaman salah kirim**: jika device dari aturan 1/2 bernama A, sedangkan hostname di config adalah B dan **B adalah device lain di twin**, file **ditahan** (Perlu Tindakan: salah kirim) dan tidak diterapkan. Jika B tidak ada di twin (misalnya hostname diganti), backup diterapkan ke A disertai peringatan di log.
5. **Simpan versi**: dibandingkan SHA-256 dengan versi terakhir device. Jika **sama**, tidak dibuat versi baru; hanya "terakhir diterima" yang diperbarui dan dicatat "tidak berubah". Jika **beda**, disimpan sebagai versi baru (file asli dan teks hasil konversi).
6. **Terapkan ke twin** (jika saklar *Terapkan otomatis* aktif, default aktif) dengan **merge sinkron**:
   - Route, rule firewall, dan NAT yang dibuat dari backup diberi tanda `origin: "config"`. Setiap backup baru **mengganti seluruh** entri bertanda itu dengan isi config terbaru.
   - Entri **tanpa tanda** (dibuat manual di twin) dan route hasil SSH Sync (`origin: "rib"`, OSPF/BGP) **tidak disentuh**.
   - **Adopsi pertama**: entri lama yang identik dengan isi config ditandai `config` (tidak dobel). Entri lama yang tidak ada di config dianggap manual dan dibiarkan.
   - **Urutan rule**: rule manual tetap di atas (urutannya dipertahankan), diikuti rule dari config sesuai urutan di perangkat.
   - **Interface**: IP/status diperbarui dan interface baru ditambahkan. Interface yang hilang dari config **tidak dihapus** (bisa memutus kabel topologi), hanya diberi peringatan di log. Route Connected dibuat ulang dari IP interface terbaru.
   - VRF/zone baru dibuat bila perlu dan tidak pernah dihapus otomatis.
   - Revisi device dinaikkan, sehingga user yang sedang mengedit device itu mendapat konflik 409 seperti biasa.
7. **Catat** di Pusat Log dengan ringkasan perubahan, misalnya `R1: interface +2 (1 hilang dari config), route +3 −1, rule +5 −2, NAT ±0`.

**Saklar dan retensi** (di Settings)
- *Terapkan backup otomatis ke twin*: default **aktif**. Saat mati, backup hanya disimpan; penerapan dilakukan manual per versi.
- *Simpan versi backup selama*: default **365 hari** (30–3650). Versi terbaru tiap device selalu dipertahankan.
- Item **Perlu Tindakan** yang tidak ditangani dalam **30 hari** dihapus otomatis (dicatat).

**Deteksi telat**: setiap jam, device yang pernah mengirim backup tetapi tidak menerima apa pun (termasuk "tidak berubah") selama **26 jam** ditandai **Telat** dan dicatat sekali sebagai `warn` sampai backup berikutnya masuk.

**Receiver offline**: jika heartbeat tidak datang selama 3 menit, dicatat `warn` ("receiver tidak merespons"); saat kembali, dicatat `info`.

**Hubungan dengan data lain**
- **Hapus device**: tautan akun dan alias ke device itu dilepas, sedangkan riwayat versi tetap tersimpan sampai retensi (ditampilkan "dihapus dari twin").
- **Factory Reset**: akun, riwayat versi, dan antrean Perlu Tindakan **tidak** dihapus; tautan ke device yang terhapus dilepas. Backup berikutnya masuk ke Perlu Tindakan sampai admin membuat ulang devicenya.
- Config berisi hash password, PSK, dan community SNMP, disimpan apa adanya di database (sama seperti data lain). Akses hanya admin, dan setiap unduhan dicatat.

## Penyimpanan

MySQL (mode file: setara di `data/backups/`):

| Tabel | Isi |
|---|---|
| `backup_accounts` | id, username (unik), password_hash (bcrypt), node_id (boleh kosong), allowed_ips (JSON), enabled, created_at, last_used_at, last_ip |
| `config_backups` | id, upload_id (unik), node_id (boleh kosong), hostname, vendor, status (`applied` · `stored` · `unknown` · `held` · `parse-error` · `dismissed`), protocol, account_id, source_ip, filename, size, sha256, received_at, summary (JSON), raw (LONGBLOB, file asli), text (MEDIUMTEXT, hasil konversi) |
| `backup_device_status` | node_id, last_received_at, last_version_id, last_protocol, last_source_ip, late_alerted_at |
| `backup_aliases` | hostname_key (unik), node_id |

Pengaturan (`backupAutoApply`, `backupRetentionDays`) disimpan bersama Settings. Status receiver (heartbeat terakhir, fingerprint, protokol) disimpan di memori app.

## API (admin, aksi `manage-settings`)

| Method & path | Isi |
|---|---|
| `GET /api/backups/status` | Status receiver, protokol/port, fingerprint, `BACKUP_PUBLIC_HOST`, jumlah Perlu Tindakan & Telat |
| `GET /api/backups/devices` | Per device: vendor, akun, terakhir diterima, status (OK/Telat/Gagal parse/Ditahan), jumlah versi |
| `GET /api/backups/devices/:nodeId/versions` | Daftar versi (tanpa isi) |
| `GET /api/backups/versions/:id` | Metadata + teks config |
| `GET /api/backups/versions/:id/raw` | File asli (unduhan, dicatat) |
| `GET /api/backups/diff?from=&to=` | Diff baris antara dua versi |
| `POST /api/backups/versions/:id/apply` | Terapkan versi ini ke twin (sinkron) |
| `GET /api/backups/pending` | Item Perlu Tindakan |
| `POST /api/backups/pending/:id/create-device` | `{ type }` → buat device dari backup, lalu terapkan |
| `POST /api/backups/pending/:id/link` | `{ nodeId }` → simpan alias (dan tautkan akun bila belum), lalu terapkan |
| `DELETE /api/backups/pending/:id` | Abaikan |
| `GET/POST /api/backups/accounts` | Daftar / buat akun (`{ username, password?, nodeId?, allowedIps? }`; password kosong = dibuat acak 24 karakter dan dikembalikan **sekali**) |
| `PUT /api/backups/accounts/:id` | Ubah device, IP perangkat, aktif/nonaktif, atau reset password |
| `DELETE /api/backups/accounts/:id` | Hapus akun |

Internal (port 3001, header `X-Receiver-Token`): `POST /internal/receiver/heartbeat`, `POST /internal/receiver/uploads`, `POST /internal/receiver/events`.

## Antarmuka: menu "Config Backups" (admin)

Badge kuning di sidebar menunjukkan jumlah Perlu Tindakan + Telat (tersembunyi bila 0).

- **Status receiver** di atas: online/offline, protokol dan port, fingerprint host key (dengan tombol salin), backup terakhir. Jika fitur nonaktif (`RECEIVER_TOKEN` kosong), tampil panduan singkat cara mengaktifkannya.
- **Tab Device**: tabel device, vendor, akun, terakhir diterima (relatif), status berwarna, dan jumlah versi. Klik device untuk membuka:
  - daftar versi: waktu, protokol, IP sumber, ukuran, ringkasan perubahan, status;
  - **Lihat config** (monospace, dengan pencarian);
  - **Bandingkan**: pilih dua versi, default terbaru vs sebelumnya. Diff unified dengan nomor baris, tambah hijau, hapus merah, dan opsi "hanya bagian yang berubah";
  - **Unduh file asli**;
  - **Terapkan versi ini ke twin**, dengan konfirmasi modal.
- **Tab Perlu Tindakan**: hostname, vendor, akun, IP, waktu, alasan (belum dikenal / salah kirim ke device X). Aksi: **Buat device baru** (tipe diisi dari vendor: FortiGate/PAN-OS/ScreenOS/Junos berzona → firewall, lainnya → router; bisa diubah), **Hubungkan ke device…**, atau **Abaikan**.
- **Tab Akun**: tabel username, device, IP perangkat, status, dan terakhir dipakai (waktu + IP). Tambah akun menampilkan password **sekali** (tombol salin) beserta contoh perintah untuk device tersebut. Tersedia juga reset password, aktif/nonaktifkan, dan hapus (konfirmasi modal).
- **Tab Panduan Setup**: contoh perintah per vendor yang terisi otomatis dengan `BACKUP_PUBLIC_HOST`, port, dan username akun yang dipilih:
  - Cisco IOS: `archive` + `path scp://…` + `time-period 1440` + `write-memory`;
  - Junos: `system archival configuration transfer-interval 1440 archive-sites`;
  - FortiGate: automation stitch harian dengan aksi CLI `execute backup config sftp …`;
  - PAN-OS: ekspor terjadwal lewat Panorama (SCP), atau `scp export configuration` yang dipicu dari luar;
  - ScreenOS: `save config to tftp …` (ScreenOS tidak punya penjadwal sendiri).

  Sintaks tiap perintah diverifikasi terhadap dokumentasi vendor saat implementasi, dan halaman ini mencantumkan versi firmware acuannya.
- Semua konfirmasi memakai modal in-app; teks tersedia dalam bahasa Inggris dan Indonesia.

## Penanganan error

| Situasi | Perilaku |
|---|---|
| Token internal salah/kosong | 401, dicatat `warn` |
| App mati saat file masuk | File ditahan di spool receiver dan dikirim ulang |
| File rusak (gzip/tar gagal dibuka, biner) | Versi disimpan dengan status gagal parse, dicatat `error` |
| Upload terpotong (koneksi putus) | Tidak diteruskan; dicatat `warn` di receiver |
| Device yang ditautkan akun sudah dihapus | Diperlakukan sebagai akun tanpa device (aturan 3–5) |
| Admin menerapkan versi saat device sedang diedit user lain | Revisi naik; user lain mendapat 409 saat menyimpan |
| Username akun sudah dipakai | 409 |

## Pengujian

- **Receiver (pytest)**: upload sungguhan lewat SFTP (klien asyncssh), SCP (klien asyncssh scp), FTP (ftplib), dan TFTP (klien uji kecil, termasuk retransmisi). Juga diuji: download/list/hapus/rename file lain/exec/port forwarding ditolak; RRQ TFTP ditolak; allowlist jaringan dan IP per akun; TFTP dari IP tak terdaftar ditolak; throttle login; batas ukuran; spool dikirim ulang setelah app stub hidup kembali, tanpa duplikasi (`uploadId`); cache akun bertahan setelah restart; heartbeat.
- **App (vitest)**: buka gzip/tgz/teks; konverter Junos (komentar, `inactive:`, string berkutip, daftar `[ ]`, routing-instances) dan PAN-OS XML (entry, member, vsys) menghasilkan `set` yang lolos parser; urutan pengenalan device termasuk pengaman salah kirim; dedupe SHA-256; merge sinkron (hapus entri `config` yang hilang, entri manual dan `rib` utuh, adopsi pertama tanpa dobel, urutan rule, interface tidak dihapus, Connected dibuat ulang); retensi versi; kedaluwarsa Perlu Tindakan; deteksi telat; storage file dan MySQL tiruan.
- **HTTP (build produksi)**: rute internal hanya di port internal dan butuh token; upload → device ter-update dan versi tersimpan; upload identik → tidak berubah; route dihapus di config → hilang di twin; unknown → create/link/dismiss; salah kirim ditahan; diff; terapkan versi lama; akun CRUD dan password sekali tampil; non-admin 403; semua kejadian ada di Pusat Log.
- **Browser**: menu, badge, tab Device + diff + terapkan versi, Perlu Tindakan, Akun, Panduan Setup, tanpa dialog bawaan browser.
- **Batasan verifikasi**: mesin pengembangan ini tidak memiliki Docker, sehingga `docker-compose.yml` hanya diperiksa sintaksnya. Uji dengan perangkat sungguhan (port, NAT TFTP/FTP passive, perintah per vendor) dilakukan setelah deploy dengan checklist di README.

## Di luar cakupan

Server pull terjadwal via SSH, syslog perangkat, push config dari NetTwin ke perangkat (restore ke device), enkripsi khusus untuk isi backup, notifikasi email/Telegram, dan penerimaan via HTTP(S) upload.
