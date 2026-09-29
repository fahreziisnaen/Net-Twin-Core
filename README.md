# NetTwin Core

**Digital twin jaringan L3 untuk network engineer.** Modelkan topologi multi-vendor Anda, lalu simulasikan alur paket hop-by-hop untuk memverifikasi routing, firewall policy, NAT, dan kepatuhan (compliance) — tanpa menyentuh perangkat produksi.

> 📘 Baru pertama pakai? Baca **[TUTORIAL.md](TUTORIAL.md)** — panduan langkah demi langkah dari login sampai import config & simulasi.

Aplikasi mandiri dengan autentikasi, database, dan parser konfigurasi statis multi-vendor. **Tidak memakai AI atau layanan eksternal apa pun** — seluruh pemrosesan (simulasi, parsing config, what-if) berjalan lokal di server Anda.

## Fitur utama

- **Path Simulator** — trace hop-by-hop dengan keputusan routing nyata: Longest Prefix Match, Administrative Distance (Connected 0 / Static 1 / BGP 20 / OSPF 110), metric tie-break, evaluasi firewall berbasis zona (first-match + implicit deny), dan translasi NAT (Static & PAT) per hop. Deteksi loop & no-route.
- **Config Importer (statis, offline)** — upload / paste running-config, parser membaca **interface, VRF/zone, route, ACL/policy, dan NAT** secara deterministik. Hasil tampil sebagai tabel yang bisa **dikoreksi & dicentang** sebelum di-apply sebagai device baru atau merge ke device yang ada. **Tidak ada data yang dikirim keluar.**
- **SSH Sync (read-only)** — tarik data langsung dari perangkat via SSH (sidecar Python + Netmiko): running-config → parser yang sama, route table → **RIB nyata per VRF termasuk OSPF/BGP dinamis** (kelima vendor; route yang ditarik perangkat ikut hilang saat sync ulang), **ARP** → mengisi IPAM dengan host live, **LLDP/CDP** → **auto-cabling** topologi. Menampilkan **drift** vs twin sebelum apply. **Read-only dijamin lewat whitelist perintah** (dua lapis); kredensial **terenkripsi (AES-256-GCM)**; **host key verification (TOFU)** anti-MITM dengan deteksi perubahan + re-pin; audit log; hanya admin. Vendor: **Cisco IOS, Juniper Junos (EX), Juniper ScreenOS (SSG), FortiGate, Palo Alto PAN-OS**. Opsional — aplikasi tetap jalan penuh tanpa fitur ini.
- **Parser Profiles** — logika parsing tiap vendor adalah **data (JSON), bukan kode**, tersimpan di database dan bisa Anda **edit / tambah dari web** lengkap dengan **Live Test**. Bawaan: Cisco IOS/IOS-XE, FortiGate FortiOS, Juniper Junos/SRX, Palo Alto PAN-OS, **Juniper ScreenOS (SSG/NetScreen)**. Vendor baru = buat profile baru, tanpa deploy ulang. Profil ini melayani **upload manual maupun SSH** sekaligus.
- **Inventory** — CRUD device, VRF, interface (otomatis + connected route), routing table, dan **kabel fisik** antar interface.
- **IP Allocation (IPAM)** — per subnet/VLAN: lihat IP mana **terpakai** (otomatis dari interface, host, & Static NAT) dan mana **kosong** siap dialokasikan, lengkap dengan utilisasi %, "next available", pencarian IP, **reservasi manual + catatan** (mis. `10.100.20.50 → Printer Lantai 3`), dan shortcut *simulate from this IP*.
- **Firewall Rule Manager** — tambah / edit / hapus / **reorder** policy (urutan = prioritas first-match).
- **NAT** — Static NAT (1:1, dua arah) dan PAT (many:1 outbound) per firewall, plus playground translasi header.
- **Compliance Auditor** — audit reachability / isolasi (mis. segmentasi PCI-DSS) yang bisa dijalankan ulang kapan pun.
- **Change Center** — draft perubahan policy dengan **what-if before/after otomatis** dan approval (admin).
- **RBAC + login** — tiga role: `admin`, `operator`, `viewer`. Sesi JWT httpOnly, password bcrypt, rate-limit login.
- **Persistence** — **MySQL** (via Docker) atau **file JSON** (mode dev tanpa DB), plus export/import snapshot.
- **Dwibahasa (i18n)** — UI **Inggris (default)** & **Indonesia**, dapat diganti lewat pemilih **EN/ID** (tersimpan per-browser). Bahasa default aplikasi adalah Inggris.

## Menjalankan dengan Docker (disarankan)

Prasyarat: Docker + Docker Compose.

```bash
cp .env.example .env
# isi minimal JWT_SECRET (dan sebaiknya ADMIN_PASSWORD, DB_PASSWORD, DB_ROOT_PASSWORD):
#   openssl rand -hex 32
docker compose up -d --build
docker compose ps          # tunggu status app "healthy"
```

Buka `http://<host>:3000` dan login sebagai **admin** dengan password dari `ADMIN_PASSWORD`. Bila `ADMIN_PASSWORD` dikosongkan, password acak dibuat saat boot pertama dan dicetak sekali di log: `docker compose logs app | grep password`. **Segera ganti password** via Settings → User Management.

Konfigurasi lewat environment (file `.env` di folder ini — lihat `.env.example`):

| Variabel | Default | Keterangan |
|---|---|---|
| `JWT_SECRET` | _(wajib)_ | Secret penandatangan token sesi. `docker compose` menolak jalan bila kosong; di `NODE_ENV=production` server menolak start bila kosong, < 16 karakter, atau masih nilai contoh. |
| `ADMIN_PASSWORD` | _(acak di produksi, `admin123` di dev)_ | Password akun `admin` yang dibuat saat boot pertama (diabaikan setelahnya). |
| `TRUST_PROXY` | _(kosong)_ | Set `1` bila di belakang reverse proxy (nginx/Traefik) — agar IP klien (rate-limit login) dan HTTPS (flag cookie `Secure`) terbaca benar. Sekaligus set `APP_PORT=127.0.0.1:3000` agar app hanya bisa diakses lewat proxy (kalau tidak, klien bisa memalsukan `X-Forwarded-For`). |
| `COOKIE_SECURE` | _(otomatis)_ | Default: cookie sesi diberi flag `Secure` otomatis untuk request HTTPS. Set `true` untuk memaksa (hanya bila selalu via HTTPS), `false` untuk mematikan. |
| `APP_PORT` | `3000` | Port yang dipublikasikan docker-compose (boleh `127.0.0.1:3000`). |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Hanya di luar Docker: port & alamat listen server Node. |
| `DB_PASSWORD` | `nettwin` | Password user MySQL `nettwin` (MySQL tidak dipublikasikan keluar). |
| `DB_ROOT_PASSWORD` | `nettwin-root` | Password root MySQL |
| `CRED_KEY` | _(kosong = SSH Sync nonaktif)_ | Kunci enkripsi (AES-256-GCM) password perangkat SSH. Nilai acak ≥ 16 karakter. Mengganti kunci ini membuat password tersimpan tak bisa dibuka (isi ulang). |
| `COLLECTOR_TOKEN` | _(kosong = SSH Sync nonaktif)_ | Secret bersama app ↔ sidecar collector. Tanpa token, collector menolak semua request. |

Fitur **SSH Sync** memerlukan container **`collector`** (otomatis ikut di `docker compose up`) serta `CRED_KEY` + `COLLECTOR_TOKEN`. Sidecar ini adalah **satu-satunya komponen yang menyentuh perangkat**, berjalan read-only di jaringan internal (tanpa port publik), dan butuh reachability ke **management IP** perangkat Anda dari host tempat aplikasi berjalan. Kalau tidak dipakai, biarkan saja — sisa aplikasi berfungsi penuh.

Data MySQL tersimpan di volume `db_data` sehingga aman saat container di-recreate. Container app punya healthcheck (`GET /api/health`, status 503 bila penyimpanan ke database sedang gagal — penyimpanan dicoba ulang otomatis) dan menyimpan perubahan yang tertunda sebelum berhenti (`docker compose stop`).

### Upgrade dari versi sebelumnya

- `docker-compose.yml` tidak lagi memakai secret bawaan. Buat `.env` berisi `JWT_SECRET` sebelum `docker compose up` (sesi lama otomatis tidak berlaku — semua user login ulang).
- Bila sebelumnya `CRED_KEY` memakai nilai bawaan `change-me-in-production` **atau lebih pendek dari 16 karakter**, SSH Sync kini menolaknya: set `CRED_KEY` baru (acak, ≥ 16 karakter) lalu **isi ulang password** koneksi SSH.
- `COLLECTOR_TOKEN` kini wajib diisi (≥ 16 karakter disarankan) untuk SSH Sync; collector menolak semua request tanpa token.
- Bundle server kini ada di `dist-server/server.cjs` (dulu `dist/server.cjs`, yang ikut ter-serve publik).
- Profil parser bawaan yang sudah tersimpan tidak diperbarui otomatis (agar editan admin tidak tertimpa). Bila Anda tidak pernah mengedit profil bawaan, klik **Parser Profiles → Reset built-in profiles** setelah upgrade untuk mendapat perbaikan parser terbaru (mis. dukungan `vrf definition` IOS-XE).

## Menjalankan tanpa Docker (mode dev)

Prasyarat: Node.js 20+.

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`. Tanpa `DB_HOST`, penyimpanan memakai **file JSON** di folder `data/` (`twin-state.json`, `users.json`, `parser-profiles.json`, `device-connections.json`). Bila menjalankan image Docker tanpa MySQL, mount volume ke `/app/data` agar data tidak hilang saat container dibuat ulang. Untuk memakai MySQL eksternal, set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` di `.env`.

## Role & izin (RBAC)

| Aksi | viewer | operator | admin |
|---|---|---|---|
| Lihat topology / audit / changes & **simulasi path** | ✓ | ✓ | ✓ |
| CRUD device / link / route / NAT / audit, **import config**, draft change request | — | ✓ | ✓ |
| **Approve & apply** change request | — | — | ✓ |
| Engine settings, reset, import snapshot | — | — | ✓ |
| **Edit / tambah Parser Profile** (dan Live Test draft yang belum disimpan) | — | — | ✓ |
| Live Test profile yang tersimpan | — | ✓ | ✓ |
| Manajemen user | — | — | ✓ |

Perubahan role, penghapusan user, dan penggantian password berlaku **langsung** (setiap request memeriksa ulang user di database; ganti password membatalkan sesi lama). Sesi berumur 12 jam; sesi kedaluwarsa otomatis mengembalikan ke layar login. Kontrol yang tidak diizinkan role Anda disembunyikan di UI.

## Keamanan (yang sudah & yang perlu Anda lakukan)

Sudah ada: JWT httpOnly + bcrypt, guard RBAC di semua endpoint, validasi skema untuk semua data twin yang masuk (edit manual, import config/SSH, snapshot), deteksi edit bersamaan (revisi per device), rate-limit login (10 gagal / 15 menit / IP), fail-fast bila `JWT_SECRET` lemah di produksi, password admin awal acak di produksi, cookie `Secure` otomatis untuk HTTPS, proteksi "admin terakhir", header keamanan dasar, container berjalan sebagai user non-root.

Yang perlu Anda lakukan sebelum dipakai bersama: isi `.env` (minimal `JWT_SECRET`), ganti password admin setelah login pertama, dan taruh di belakang **HTTPS** (reverse proxy + `TRUST_PROXY=1`) bila diakses lintas jaringan. Dengan Docker, batasi akses lewat `APP_PORT` (mis. `127.0.0.1:3000` di belakang proxy) atau firewall; di luar Docker lewat `HOST`. Sidecar collector dan MySQL tidak dipublikasikan keluar.

## Development

```bash
npm test        # unit test (vitest): engine simulasi, parser, auth/sesi, validasi, storage, RBAC, i18n
npm run lint    # typecheck (tsc --noEmit) — frontend & backend
npm run build   # frontend (vite) -> dist/, server (esbuild) -> dist-server/
npm start       # jalankan hasil build (set NODE_ENV=production & JWT_SECRET)
```

## Arsitektur singkat

```
src/
  engine.ts          # engine simulasi path (pure, teruji) — LPM, AD, firewall, NAT
  seedData.ts        # topologi enterprise reference bawaan
  rbac.ts            # matriks izin role -> action
  types.ts           # tipe domain bersama (frontend + backend)
  nodeUtils.ts       # ID device unik + merge non-destruktif (Importer & SSH Sync)
  components/        # UI React per tab
server/
  env.ts             # memuat .env (di-import paling awal oleh server.ts)
  auth.ts            # JWT, bcrypt, sesi yang divalidasi ulang ke DB, guard requireAction, seed admin
  validate.ts        # validasi/normalisasi skema data twin & parser profile dari API
  storage.ts         # adapter penyimpanan: MySqlStorage & FileStorage (tulis atomik)
  saveQueue.ts       # penyimpanan latar berurutan (tanpa tulis paralel)
  collector/         # SSH collect: whitelist perintah, normalizer, drift
  parsers/
    engine.ts        # engine parser generik (interpreter profile) — TIDAK vendor-specific
    profiles.ts      # 4 profile vendor bawaan (DATA)
    types.ts         # skema ParserProfile
server.ts            # Express: REST API + auth + serve SPA
```

Prinsip inti: **engine adalah kode, aturan adalah data.** Baik engine simulasi maupun engine parser tidak menghardcode kasus spesifik — perilaku ditentukan oleh data (seed topology, parser profiles) yang bisa diubah tanpa mengubah kode.
