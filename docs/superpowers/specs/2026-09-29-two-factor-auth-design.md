# Spesifikasi: 2FA Google Authenticator (TOTP)

Tanggal: 2026-09-29 · Status: menunggu review

## Tujuan

Menambah lapisan login kedua berbasis aplikasi authenticator (Google Authenticator, Microsoft Authenticator, Authy, 2FAS, dll.) karena NetTwin Core kini dapat diakses dari internet lewat Cloudflare. Password yang bocor atau tertebak tidak lagi cukup untuk masuk ke akun yang mengaktifkan 2FA.

**Keputusan yang sudah disetujui**
- 2FA **opsional per user**: tiap user mengaktifkan sendiri; tidak ada kewajiban per role.
- Pendekatan: **TOTP ditulis sendiri** (RFC 6238, memakai modul `crypto` bawaan Node) + **QR code dibuat di browser**. Tidak ada dependency baru di server.

**Kriteria berhasil**
1. User bisa mendaftarkan 2FA dengan memindai QR dari halaman Settings.
2. Akun ber-2FA hanya bisa login dengan password **dan** kode 6 digit (atau kode cadangan).
3. User yang kehilangan HP tetap bisa masuk (kode cadangan) atau dipulihkan admin.
4. Akun tanpa 2FA login persis seperti sekarang.
5. Upgrade tidak mengubah tabel `users` yang sudah ada di MySQL produksi.

## Parameter TOTP

| Parameter | Nilai |
|---|---|
| Algoritma | HMAC-SHA1 (default Google Authenticator) |
| Digit | 6 |
| Periode | 30 detik |
| Toleransi jam | ±1 periode (±30 detik) |
| Secret | 20 byte acak (160 bit), dikodekan Base32 |
| URI QR | `otpauth://totp/NetTwin%20Core:<username>?secret=<BASE32>&issuer=NetTwin%20Core&algorithm=SHA1&digits=6&period=30` |

Kode yang sudah dipakai tidak bisa dipakai lagi: server menyimpan nomor periode terakhir yang berhasil (`lastStep`), dan hanya menerima kode dengan periode lebih besar.

## Alur

### 1. Mendaftar (Settings → kartu "Keamanan Akun", semua role)
1. User klik **Aktifkan 2FA** dan memasukkan **password saat ini**.
2. Server membuat secret baru berstatus *pending* dan mengembalikan secret + URI.
3. Browser menampilkan **QR code** dan kunci manual (dikelompokkan 4 karakter).
4. User memasukkan kode 6 digit dari aplikasi → server memverifikasi → 2FA **aktif**.
5. Server membuat **10 kode cadangan** sekali pakai (format `xxxx-xxxx`, huruf kecil + angka tanpa karakter yang mirip seperti `0/o` dan `1/l`) yang ditampilkan **sekali saja**, dengan tombol salin dan unduh (.txt). Saat login, kode cadangan dan kode 6 digit diterima tanpa peduli huruf besar/kecil, spasi, atau tanda hubung.

Mengulang langkah 1 saat masih *pending* mengganti secret pending. Jika 2FA sudah aktif, pendaftaran ditolak sampai 2FA dimatikan.

### 2. Login
1. `POST /api/auth/login` dengan password benar:
   - user **tanpa** 2FA → sesi diberikan seperti sekarang;
   - user **dengan** 2FA → **belum ada sesi**; balasan `{ twoFactorRequired: true, challenge }`.
2. Layar login berganti ke isian kode ("Masukkan kode dari aplikasi authenticator, atau kode cadangan").
3. `POST /api/auth/login/2fa { challenge, code }` → jika valid, cookie sesi diset dan balasan sama seperti login biasa. Jika yang dipakai kode cadangan, balasan menyertakan sisa kode cadangan agar UI bisa memperingatkan bila tinggal sedikit.

**Challenge** adalah token bertanda tangan (HS256, kunci `JWT_SECRET`) berumur **5 menit** dengan klaim `typ: "2fa"`, id user, dan stempel password. Ia **tidak bisa** dipakai sebagai sesi: token sesi kini membawa `typ: "session"` dan middleware menolak token ber-`typ` lain (token sesi lama tanpa `typ` tetap diterima agar user tidak ter-logout saat upgrade). Mengganti password membatalkan challenge yang sedang berjalan.

Kode 2FA yang salah dihitung dalam batas yang sama dengan password salah: **10 kegagalan per IP per 15 menit**.

### 3. Mematikan 2FA (oleh user sendiri)
Masukkan **password** + **kode 6 digit atau kode cadangan** → 2FA dan semua kode cadangan dihapus.

### 4. Reset oleh admin (HP hilang)
Di tabel User Management, admin melihat tanda **2FA** per user dan tombol **Reset 2FA** (konfirmasi lewat modal). Tombol ini hanya untuk **user lain**; admin mematikan 2FA miliknya sendiri lewat alur no. 3. Setelah di-reset, user login dengan password saja dan bisa mendaftar ulang.

### 5. Pemulihan darurat
Jika admin satu-satunya kehilangan HP **dan** semua kode cadangan, README memuat satu perintah database untuk mematikan 2FA akun tersebut:
```sql
DELETE FROM user_two_factor WHERE user_id = (SELECT id FROM users WHERE username = 'admin');
```

## API

| Method & path | Akses | Isi |
|---|---|---|
| `POST /api/auth/login` | publik | Tetap; balasan baru `{ twoFactorRequired, challenge }` untuk akun ber-2FA |
| `POST /api/auth/login/2fa` | publik (butuh challenge) | `{ challenge, code }` → sesi |
| `GET /api/auth/2fa` | login | `{ enabled, pending, recoveryCodesLeft }` |
| `POST /api/auth/2fa/setup` | login | `{ password }` → `{ secret, otpauthUrl }` (pending) |
| `POST /api/auth/2fa/enable` | login | `{ code }` → `{ recoveryCodes: string[] }` (sekali tampil) |
| `POST /api/auth/2fa/disable` | login | `{ password, code }` |
| `GET /api/users` | admin | Setiap user kini membawa `twoFactorEnabled` |
| `DELETE /api/users/:id/2fa` | admin | Reset 2FA user lain |

Semua perubahan status 2FA dicatat di log server (`[AUDIT] 2FA enabled/disabled/reset ...`).

## Penyimpanan

**MySQL** — tabel **baru** (tabel `users` tidak diubah, sehingga upgrade aman di database yang sudah berjalan):
```sql
CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id INT PRIMARY KEY,
  data JSON NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```
**File JSON** (mode dev) — `data/two-factor.json` (peta id user → data); menghapus user ikut menghapus datanya.

Isi `data`:
| Field | Keterangan |
|---|---|
| `secretEnc` | Secret TOTP terenkripsi AES-256-GCM; kunci diturunkan dari `JWT_SECRET` |
| `enabled` | `false` selama pendaftaran belum dikonfirmasi |
| `recoveryHashes` | SHA-256 dari tiap kode cadangan yang belum dipakai |
| `lastStep` | Nomor periode TOTP terakhir yang diterima (anti pemakaian ulang) |

**Konsekuensi yang disengaja:** jika `JWT_SECRET` diganti, secret 2FA tidak bisa dibaca lagi. User tersebut login dengan **kode cadangan** (disimpan sebagai hash, tidak bergantung pada `JWT_SECRET`) atau di-reset admin, lalu mendaftar ulang. Ini didokumentasikan di README.

## Antarmuka

- **Login**: langkah kedua pada kartu login yang sama — isian kode (6 digit atau format kode cadangan), tombol Verifikasi, dan tautan "Kembali" untuk mengulang dari password.
- **Settings → Keamanan Akun** (baru, semua role): status 2FA, tombol Aktifkan/Matikan, alur pendaftaran bertahap (password → QR + kunci manual → kode → kode cadangan), dan peringatan bila sisa kode cadangan ≤ 3.
- **User Management** (admin): kolom/tanda 2FA dan tombol Reset 2FA.
- QR dibuat di browser dengan paket `qrcode` (ikut dibundel Vite; tidak menambah dependency server).
- Semua konfirmasi memakai modal in-app yang sudah ada; teks tersedia dalam Inggris dan Indonesia.

## Penanganan error

| Situasi | Perilaku |
|---|---|
| Kode salah / kedaluwarsa | 401 "Kode tidak valid" dan dihitung ke batas percobaan |
| Challenge kedaluwarsa (> 5 menit) | 401; UI kembali ke langkah password |
| Kode sudah pernah dipakai | Ditolak seperti kode salah |
| Secret tidak bisa didekripsi (JWT_SECRET berganti) | Kode TOTP ditolak dengan pesan untuk memakai kode cadangan / hubungi admin |
| Setup saat 2FA sudah aktif | 409 |
| Admin me-reset 2FA dirinya sendiri | 400 (pakai alur matikan 2FA) |

## Pengujian

- **Unit**: test vector resmi RFC 6238 (SHA1); toleransi ±1 periode; penolakan pemakaian ulang; kode cadangan hanya berlaku sekali; enkripsi/dekripsi secret; challenge tidak diterima sebagai sesi dan sebaliknya; challenge batal setelah ganti password; storage 2FA di MySQL (pool tiruan) dan file.
- **HTTP (build produksi)**: daftar → login meminta kode → login dengan kode yang dihitung dari secret → kode yang sama ditolak kedua kalinya → login dengan kode cadangan → kode cadangan yang sama ditolak → matikan → reset oleh admin → user tanpa 2FA tidak terpengaruh → batas percobaan berlaku untuk kode salah.
- **Browser**: alur pendaftaran lengkap (QR tampil, kode diterima, kode cadangan tampil), login dua langkah, reset admin; nol dialog bawaan browser.

## Di luar cakupan

Mewajibkan 2FA per role, WebAuthn/passkey, "ingat perangkat ini", pembuatan ulang kode cadangan tanpa mematikan 2FA, dan 2FA lewat SMS/email.
