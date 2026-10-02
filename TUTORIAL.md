# Tutorial Lengkap NetTwin Core

Panduan penggunaan dari nol untuk network engineer. Ikuti berurutan jika baru pertama kali; lompati ke bagian yang relevan bila sudah paham dasarnya.

**Daftar isi**

1. [Konsep dasar](#1-konsep-dasar)
2. [Login & peran (role)](#2-login--peran-role)
3. [Path Simulator — jantung aplikasi](#3-path-simulator--jantung-aplikasi)
4. [Global Topology](#4-global-topology)
5. [Inventory — device, VRF, interface, route, kabel](#5-inventory--device-vrf-interface-route-kabel)
6. [IP Allocation (IPAM)](#6a-ip-allocation-ipam)
6. [Firewall Rule Manager](#6-firewall-rule-manager)
7. [NAT](#7-nat)
8. [Compliance Auditor](#8-compliance-auditor)
9. [Change Center — what-if & approval](#9-change-center--what-if--approval)
10. [Config Importer — impor config perangkat](#10-config-importer--impor-config-perangkat)
10a. [SSH Sync — tarik data langsung dari perangkat (read-only)](#10a-ssh-sync--tarik-data-langsung-dari-perangkat-read-only)
11. [Parser Profiles — menambah/menyesuaikan vendor](#11-parser-profiles--menambahmenyesuaikan-vendor)
12. [Settings — engine, snapshot, user](#12-settings--engine-snapshot-user)
13. [Referensi format Parser Profile](#13-referensi-format-parser-profile)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Konsep dasar

NetTwin Core adalah **digital twin** — salinan virtual jaringan Anda. Anda memodelkan perangkat (router/firewall/switch/host), kabel yang menghubungkannya, tabel routing, firewall policy, dan NAT. Lalu Anda **mensimulasikan sebuah paket** dari titik A ke titik B dan aplikasi menelusuri jalurnya hop demi hop, menerapkan aturan routing dan keamanan yang persis seperti perangkat asli — sehingga Anda bisa menjawab "apakah trafik ini akan sampai / diblokir, dan di mana?" tanpa menyentuh jaringan produksi.

Istilah penting:
- **VRF / Zona** — konteks routing L3. Pada router = VRF; pada firewall diperlakukan sebagai security zone.
- **Hop** — satu langkah paket melewati satu perangkat.
- **LPM (Longest Prefix Match)** — route paling spesifik menang. Bila sama panjang prefix-nya, dipilih berdasarkan Administrative Distance lalu metric.
- **First-match firewall** — rule dievaluasi dari atas ke bawah; yang cocok pertama menentukan permit/deny. Bila tak ada yang cocok → **implicit deny** (bisa dimatikan di Settings).

Aplikasi sudah berisi **topologi contoh** (Core-R1, Core-R2, Edge-FW01, zona PRODUCTION/CORPORATE/PCI-ZONE, Internet) agar Anda bisa langsung bereksperimen.

---

## 2. Login & peran (role)

Buka `http://localhost:3000`. Login pertama dengan user **admin** dan password dari `ADMIN_PASSWORD`. Bila `ADMIN_PASSWORD` tidak di-set: di mode dev (`npm run dev`) password-nya **admin123**; di produksi/Docker password acak dibuat sekali dan dicetak di log (`docker compose logs app | grep password`). Segera ganti password setelah login.

Jika akun Anda memakai **2FA**, setelah password akan muncul isian **kode 6 digit** dari aplikasi authenticator. Kehilangan HP? Masukkan salah satu **kode cadangan** (sekali pakai) atau minta admin me-reset 2FA Anda.

Tombol & form untuk aksi yang tidak diizinkan role Anda disembunyikan. Perubahan role oleh admin berlaku **langsung** (tanpa perlu login ulang); mengganti password membuat sesi lama pengguna tersebut tidak berlaku.

Tiga peran:

| Role | Bisa apa |
|---|---|
| **viewer** | Melihat topologi & audit, menjalankan simulasi path. |
| **operator** | Semua viewer + CRUD device/route/NAT/firewall, import config, draft change request. **Tidak** bisa approve change, ubah settings, atau kelola user. |
| **admin** | Semua, termasuk approve change, engine settings, edit parser profile, dan manajemen user. |

**Langkah pertama yang disarankan:** buka **Settings → User Management**, ganti password admin, lalu buat akun `operator`/`viewer` untuk rekan tim.

Sesi berumur 12 jam. Bila kedaluwarsa, aplikasi otomatis kembali ke layar login.

**Bahasa (English/Indonesia):** aplikasi berbahasa **Inggris secara default**. Ganti ke Indonesia lewat tombol **EN / ID** — di layar login (pojok kanan form) atau di footer sidebar setelah masuk. Pilihan bahasa tersimpan di browser Anda. (Pesan error dari server tetap dalam bahasa Inggris.)

---

## 3. Path Simulator — jantung aplikasi

Menu **Path Simulator**. Di sinilah Anda memverifikasi konektivitas & kebijakan.

**Cara pakai cepat:**
1. Pilih salah satu **Preset** di kiri (mis. "Corp PC to Web App (HTTPS)") — form terisi otomatis. Atau isi manual.
2. **Source Device**: biarkan **🔍 Auto-Detect** (rekomendasi). Anda cukup mengetik **Source IP** apa pun; sistem menemukan device & gateway asalnya sendiri — Anda tidak perlu mendaftarkan tiap host.
3. Isi **Destination IP**, **Protocol** (TCP/UDP/ICMP), dan **port** (mendukung `443`, range `1024-65535`, atau list `80,443`).
4. **Bypass Security Policies** (checkbox): matikan (default) untuk simulasi penuh termasuk firewall; nyalakan bila hanya ingin fokus pada routing & NAT.
5. Klik **Run Hop Trace**.

**Membaca hasil:** Di kanan muncul verdict (Path Permitted / Blocked by Policy / Routing Drop) dan **timeline hop**. Tiap hop menampilkan: perangkat, zona ingress, route yang dipilih (LPM), interface egress, rule firewall yang dievaluasi, dan translasi NAT bila ada. Bila diblokir, hop terakhir menunjukkan **rule mana** yang memblokir.

**Contoh yang bisa dicoba:**
- Corp PC (`10.200.15.42`) → Prod Web (`10.100.20.10`) port 443 → **SUCCESS** (diizinkan rule "Corp to Prod HTTPS").
- Corp PC → PCI DB (`192.168.50.10`) port 5432 → **BLOCKED** oleh rule isolasi PCI.
- Internet client → `198.51.100.10` (IP publik) port 443 → **SUCCESS** via Static NAT ke web server internal.

---

## 4. Global Topology

Menu **Global Topology** menampilkan peta perangkat & kabel. Setelah menjalankan simulasi, **jalur aktif menyala** dan paket beranimasi mengikuti rute. Klik sebuah node untuk melihat ringkasan VRF, interface, firewall rule, dan NAT-nya di panel kanan.

---

## 5. Inventory — device, VRF, interface, route, kabel

Menu **Devices & VRF Inventory** (butuh role operator/admin untuk mengubah).

- **Pilih device** dari daftar kiri. Tambah device baru lewat **Tambah Device Baru**.
- **VRF**: klik tab VRF, atau ketik nama di kotak "VRF baru..." lalu **+** untuk menambah konteks routing.
- **Interface**: di panel VRF aktif, isi nama + IP (CIDR) lalu **Add Interface + Connected Route** — connected route dibuat otomatis. Hapus dengan ikon tong sampah (harus lepas kabelnya dulu bila terpasang).
- **Routing Table (RIB)**: cari, tambah static/OSPF/BGP route (destination CIDR, next hop, metric), atau hapus. Connected route terkunci (ikut interface).
- **Physical Links (kabel)**: hubungkan interface lokal ke interface device lain. **Ini wajib** agar simulasi bisa berpindah antar perangkat — device yang tidak terkabel akan berhenti dengan "No Route".

> Alur umum device baru: buat device → tambah interface → **pasang kabel** ke tetangga → tambah route → simulasikan.

---

## 6a. IP Allocation (IPAM)

Menu **IP Allocation (IPAM)**. Untuk menjawab: *"di subnet/VLAN ini, IP mana yang sudah dipakai dan mana yang masih kosong?"*

**Cara pakai:**
1. Panel kiri menampilkan semua **subnet** yang dikenali twin (diturunkan otomatis dari CIDR interface), lengkap dengan bar utilisasi. Tombol **Subnet / VLAN** mengubah pengelompokan; dropdown memfilter per VRF/zona.
2. Klik sebuah subnet → panel kanan menampilkan peta alamatnya:
   - **Used** — tiap IP + pemiliknya. Label `device` (dari interface perangkat/host), `NAT` (inside-local Static NAT), atau `reserved` (catatan manual Anda).
   - **Free** — daftar alamat kosong siap pakai. Network & broadcast otomatis dikecualikan.
   - Ringkasan **used / free / usable** dan **Next available** (IP kosong pertama).
3. **Reservasi manual (pencatatan):** isi IP + catatan lalu klik **Reserve** — mis. `10.100.20.50` → *Printer Lantai 3*. Berguna untuk perangkat yang tidak dimodelkan di twin (printer, CCTV, pool DHCP, rencana alokasi). Klik salah satu IP di daftar Free untuk mengisi form otomatis. Reservasi tersimpan permanen di database dan ikut ter-export di snapshot.
4. Ikon **▶** di sebelah IP = *simulate from this IP* — langsung membuka Path Simulator dengan IP tersebut sebagai sumber.

**Cara "terpakai" dihitung:** otomatis dari data twin (semua IP interface di device mana pun, host, dan inside-local Static NAT) **ditambah** reservasi manual Anda. Jadi begitu Anda menambah device/interface di Inventory atau meng-import config, peta IPAM langsung ikut ter-update.

**Soal VLAN:** aplikasi mengelompokkan per-subnet secara default. Untuk pengelompokan per-VLAN, isi field **VLAN (opsional)** saat menambah interface di Inventory — subnet tersebut lalu muncul di bawah grup VLAN-nya. Subnet tanpa label VLAN dikelompokkan sebagai "No VLAN tag".

> Catatan: IPAM ini melihat apa yang **dimodelkan di twin**, bukan hasil scan jaringan live. IP yang ada di jaringan asli tapi belum dimodelkan akan tampak "kosong" — gunakan reservasi manual atau import config untuk mencatatnya.

## 6. Firewall Rule Manager

Muncul di Inventory ketika device bertipe **firewall** dipilih. Panel "Security Policy Rules":

- Rule dievaluasi **first-match dari atas**. Gunakan panah **▲/▼** untuk mengubah prioritas.
- **Add Rule** / ikon pensil (edit) / tong sampah (hapus). Tiap rule: zona & IP source/dest, protokol, port (mendukung range/list), action permit/deny.
- Di bawah daftar tertera pengingat **implicit deny** (aktif bila dinyalakan di Settings).

Setelah mengubah rule, jalankan ulang Path Simulator atau Compliance untuk melihat dampaknya.

---

## 7. NAT

Menu **NAT Terminologies**. Pilih firewall (bila ada lebih dari satu), lalu:

- **Static NAT** — pemetaan 1:1 dua arah (inbound DNAT + outbound SNAT). Isi Inside Local (IP privat) ↔ Inside Global (IP publik) + zona.
- **PAT / Dynamic** — many:1 outbound. Isi subnet inside (CIDR) ↔ IP global.
- **Playground** — masukkan source/dest IP uji, klik translate, lihat bagaimana header berubah sesuai mapping yang aktif.

Simulasi Path akan menerapkan NAT ini otomatis: DNAT saat masuk (mengubah tujuan + zona real), SNAT/PAT saat keluar ke zona luar.

---

## 8. Compliance Auditor

Menu **Compliance Auditor**. Audit = sebuah probe (source, dest, port) + hasil yang **diharapkan** (SUCCESS / BLOCKED_BY_FIREWALL / NO_ROUTE).

- Klik **Run Active Audits** untuk menjalankan semua. Kartu berubah hijau (Pass) / merah (Fail).
- **Create Custom Rule** untuk menambah audit sendiri (mis. "segmen A tidak boleh menjangkau segmen B"). Pilih device & VRF source dari dropdown.
- Hapus audit dengan ikon tong sampah.

Gunakan ini sebagai **regression test kebijakan**: setiap kali topologi/rule berubah, jalankan audit untuk memastikan tidak ada aturan keamanan yang bocor.

---

## 9. Change Center — what-if & approval

Menu **Change Request Center**. Alur kerja perubahan firewall yang aman:

1. **New Change** → isi judul, pilih **firewall target**, dan spesifikasi 5-tuple (zona/IP source-dest, protokol, port, action).
2. **Simulate & Submit** → server menjalankan **what-if**: mensimulasikan flow sebelum & sesudah rule ditambahkan (pada salinan topologi, tidak mengubah yang live). Anda melihat panel **Before → After** (mis. `BLOCKED_BY_FIREWALL → SUCCESS`).
3. **Approve & Push Rule** (hanya admin) → rule benar-benar diterapkan ke twin dan audit dijalankan ulang. Operator hanya bisa draft; menunggu approval admin.

---

## 10. Config Importer — impor config perangkat

Menu **Config Importer** (operator/admin). Parsing **100% lokal & offline** — config Anda tidak pernah dikirim keluar.

1. **Vendor**: biarkan **🔍 Auto-detect**, atau pilih manual (Cisco / FortiGate / Junos / PAN-OS / profile custom Anda).
2. **Upload File** (`.cfg/.conf/.txt/.log`) atau **paste** running-config ke kotak.
3. Klik **Parse Config**.
4. Panel kanan menampilkan hasil sebagai **tabel yang bisa dikoreksi**: hostname, interfaces, routes, ACL/firewall policy, NAT. **Edit** nilai yang salah langsung di kolomnya, dan **hilangkan centang** item yang tak ingin diimpor.
5. Pilih target: **➕ Buat device baru** (pilih tipenya) atau **Merge ke** device yang sudah ada.
6. **Apply** — data masuk ke twin.

> **Buat device baru** tidak pernah menimpa device lain: bila nama/ID sudah dipakai, ID baru diberi akhiran (mis. `core-r1-2`).
> **Merge** bersifat non-destruktif: tipe device, kabel, rule & NAT yang sudah ada tetap; IP interface dengan nama sama diperbarui; route/rule/NAT yang belum ada ditambahkan (impor ulang config yang sama tidak menggandakan data).
>
> Bila device baru, jangan lupa **pasang kabel** di Inventory agar bisa disimulasikan.
>
> Bila hasil kosong / muncul peringatan "tidak menemukan apa pun", berarti vendor salah atau dialek config berbeda — pilih vendor yang tepat, atau sesuaikan aturannya di **Parser Profiles** (bagian berikut).

Vendor bawaan: **Cisco IOS/IOS-XE, FortiGate, Juniper Junos/SRX, Palo Alto PAN-OS, dan Juniper ScreenOS (SSG/NetScreen)**. Membaca: **interface + IP + VRF/zona, static route, ACL/security policy, dan NAT (Static + PAT/VIP/MIP)**. Fitur dinamis seperti OSPF/BGP adjacency tidak diambil dari config (pakai SSH Sync untuk RIB dinamis, atau tambahkan route manual).

---

## 10a. SSH Sync — tarik data langsung dari perangkat (read-only)

Menu **SSH Sync** (khusus **admin**). Kalau Config Importer butuh Anda menempel config manual, SSH Sync **menariknya sendiri** dari perangkat live — mengubah twin dari model manual menjadi cerminan jaringan nyata.

**Prasyarat:** jalankan via **docker-compose** (yang menyalakan container `collector`), set `CRED_KEY` dan `COLLECTOR_TOKEN` ke nilai acak yang kuat (min. 16 karakter, mis. `openssl rand -hex 32`), dan pastikan host tempat aplikasi berjalan **bisa menjangkau management IP** perangkat Anda. Tanpa keduanya, menu ini menampilkan pemberitahuan dan sisa aplikasi tetap berfungsi.

**Cara pakai:**
1. **Add** koneksi: nama, **management IP**, port (22), **vendor** (Netmiko `device_type`, mis. `cisco_ios`), **username read-only**, password, dan opsional target device (buat baru / merge ke device twin yang ada).
2. Klik **Collect now**. Aplikasi (lewat sidecar) menjalankan **hanya perintah `show` yang di-whitelist** dan menarik:
   - `show running-config` → diproses **parser yang sama** dengan Importer (interface, VRF, static route, ACL, NAT).
   - `show ip route` + `show ip route vrf *` → **RIB nyata per VRF**, termasuk route dinamis **OSPF/BGP** yang tak terlihat dari config. Setiap sync, route hasil belajar (OSPF/BGP) di VRF yang terbaca **diganti** dengan isi routing table terbaru — route yang sudah ditarik perangkat ikut hilang dari twin. Static route yang Anda buat manual tetap aman, dan VRF yang tabelnya tidak terbaca tidak disentuh.
   - `show ip arp` → **host yang benar-benar hidup** di tiap subnet.
   - `show cdp neighbors detail` → **siapa terhubung ke siapa**.
3. Panel kanan menampilkan **preview + drift** (apa yang beda vs twin): berapa interface/route baru atau berubah.
4. Centang opsi (**tambahkan host ARP ke IPAM**, **auto-kabel dari neighbor**) lalu **Apply to Digital Twin** — device masuk twin, host ARP jadi reservasi IPAM, dan link dibuat otomatis ke device tetangga yang sudah ada di twin.
   - Bila koneksi punya **target device**, data di-**merge non-destruktif** ke device itu (koleksi yang tidak menemukan policy tidak akan menghapus rule/NAT yang ada, dan firewall tidak berubah jadi router).
   - Bila belum ada target, device baru dibuat dan koneksi otomatis ditautkan ke device tersebut, sehingga koleksi berikutnya memperbarui device yang sama (bukan membuat salinan).

**Keamanan (penting untuk produksi):**
- **Read-only dijamin secara teknis** — sidecar hanya boleh menjalankan perintah dari whitelist; tidak ada jalur config-mode atau perintah bebas.
- **Kredensial terenkripsi (AES-256-GCM)** dengan `CRED_KEY`; password **tidak pernah** dikirim balik ke browser (API hanya menandai `hasPassword`).
- **Gunakan akun read-only least-privilege** di perangkat — jangan kredensial admin.
- **On-demand** (belum ada polling terjadwal), satu perangkat/timeout, dan tiap koleksi **tercatat di audit log** server.
- Sidecar `collector` **tidak di-expose ke publik** (hanya jaringan internal Docker).

**Host key verification (anti-MITM):** koleksi pertama memakai **Trust-On-First-Use** — sidik jari (fingerprint) host key perangkat ditangkap, ditampilkan, dan disimpan. Koleksi berikutnya memverifikasi fingerprint cocok; kalau **berubah** (indikasi perangkat diganti atau man-in-the-middle), koleksi **ditolak** dan Anda diberi pilihan sadar untuk mempercayai kunci baru (re-pin). Penting: verifikasi terjadi **sebelum** kredensial dikirim, jadi peniru tidak bisa menangkap password Anda.

**Vendor yang didukung:** **Cisco IOS**, **Juniper Junos (EX)**, **Juniper ScreenOS (SSG/NetScreen)**, **FortiGate**, dan **Palo Alto PAN-OS**. Untuk semua vendor, `config` diproses parser yang sama dengan Importer.

| Vendor | Routing table (RIB) | ARP | Neighbor (CDP/LLDP) |
|---|---|---|---|
| Cisco IOS | ✓ global + semua VRF | ✓ | ✓ |
| Juniper Junos | ✓ `inet.0` + routing-instance (`X.inet.0`) | ✓ | ✓ |
| FortiGate | ✓ (per VRF di FortiOS 7) | ✓ | — |
| Palo Alto PAN-OS | ✓ per virtual router | ✓ | — |
| ScreenOS | ✓ per virtual router (`trust-vr` = default) | ✓ | — |

Catatan RIB: yang diambil route **Connected, Static, OSPF, BGP** yang **aktif**, termasuk default route OSPF (`O*E2`), route di bawah header "is subnetted", dan static ke interface/tunnel (mis. `Tunnel0`, IPsec FortiGate); EIGRP/RIP/IS-IS/ODR dan route discard (`Null0`) dilewati; untuk ECMP hanya satu next-hop yang dipakai. Pada **firewall**, routing table perangkat tidak mengenal zona, jadi setiap route diletakkan di **zona milik interface egress-nya** dan seluruh zona dianggap terbaca (route yang ditarik perangkat hilang dari semua zona). Nama interface Junos disamakan dengan parser config (tanpa unit, `ge-0/0/1.0` → `ge-0/0/1`). Parser config Cisco kini juga mengenali sintaks IOS-XE `vrf definition` / `vrf forwarding`. Bila routing table tidak terbaca (perintah gagal/format tak dikenal), twin memakai static route dari config dan preview menampilkan peringatan. Parser RIB untuk FortiGate, PAN-OS, dan ScreenOS dibuat dari format output standar vendor dan **belum diuji ke perangkat nyata** — laporkan bila hasilnya tidak sesuai. Untuk FortiGate & Palo Alto, integrasi **API** (lebih andal dari SSH) direncanakan sebagai langkah berikutnya.

> Route OSPF/BGP adalah **snapshot** dari perangkat. Twin tidak menghitung ulang OSPF/BGP bila Anda mengubah topologi di twin (mis. memutus link) — lakukan collect ulang untuk kondisi terbaru.

> Catatan format: normalizer route/ARP/neighbor dibuat dari format output terdokumentasi. Karena format bisa berbeda antar versi OS, **verifikasi hasil koleksi pertama** Anda terhadap output nyata; kalau ada yang meleset, formatnya mudah disesuaikan.

> Catatan jujur: fitur ini menarik apa yang **benar-benar ada di perangkat** saat itu (bukan model). Uji terhadap perangkat produksi nyata dilakukan di lingkungan Anda; developer tidak bisa menguji ke gear Anda dari luar.

## 11. Parser Profiles — menambah/menyesuaikan vendor

Menu **Parser Profiles** (edit hanya admin). Inilah yang membuat importer **tidak hardcode**: aturan parsing tiap vendor adalah **data JSON** yang bisa Anda lihat, koreksi, dan tambah — tanpa mengubah kode atau deploy ulang.

**Anatomi layar:**
- Kiri: daftar profile (bawaan ditandai `BUILTIN`).
- Tengah: **editor JSON** definisi profile.
- Bawah: **Live Test** — tempel sampel config, klik **Test parse**, lihat langsung berapa interface/route/ACL/NAT yang terbaca.

**Menyesuaikan vendor yang ada** (mis. dialek FortiGate Anda sedikit beda):
1. Pilih profile, edit JSON di tengah.
2. Tempel config asli (yang gagal) ke Live Test → **Test parse** → perbaiki aturan sampai hasil benar.
3. **Simpan**. (Edit pada profile bawaan tetap tersimpan lintas restart; **Reset profile bawaan** mengembalikannya ke default.)

**Menambah vendor baru** — contoh lengkap MikroTik RouterOS:
1. Klik **Baru** (memuat template kosong).
2. Ganti isinya, misalnya:

```json
{
  "id": "mikrotik",
  "name": "MikroTik RouterOS",
  "detect": ["^/ip address", "^/ip route", "^/ip firewall"],
  "rules": [
    { "match": "^/system identity set name=(\\S+)", "setHostname": "$1" },
    { "match": "^/ip address add address=(\\S+) interface=(\\S+)",
      "emit": { "target": "interfaces", "fields": { "name": "$2", "ip": "$1", "status": { "lit": "up" } } } },
    { "match": "^/ip route add dst-address=(\\S+) gateway=(\\S+)",
      "emit": { "target": "routes", "fields": { "destination": "$1", "nextHop": "$2", "vrf": { "lit": "default" }, "protocol": { "lit": "Static" }, "metric": { "lit": "1" } } } },
    { "match": "^/ip firewall filter add chain=(\\S+) action=(accept|drop) .*dst-port=(\\S+)",
      "emit": { "target": "firewallRules", "fields": { "name": { "concat": ["mt-", "$1"], "sep": "" }, "action": { "resolve": "actMap", "arg": { "group": 2 }, "fallback": { "lit": "permit" } }, "destPort": "$3", "protocol": { "lit": "tcp" } } } }
  ],
  "statics": { "actMap": { "accept": "permit", "drop": "deny" } }
}
```

3. Tempel sampel config MikroTik ke Live Test, **Test parse**, sesuaikan regex sampai benar, lalu **Simpan**.
4. Vendor "MikroTik RouterOS" kini muncul di dropdown Config Importer.

Referensi lengkap format ada di [bagian 13](#13-referensi-format-parser-profile).

---

## 12. Settings — engine, snapshot, user

Menu **Simulator Settings** (kebanyakan admin-only).

- **Simulation Engine Constraints** — `Maximum Path Hop Limit (TTL)` (batas hop, cegah loop tak hingga) dan `Default-Deny Policy Action` (implicit deny on/off). Tersimpan di server & dipakai semua simulasi, audit, dan what-if.
- **Twin Snapshot** — **Export** seluruh state ke file JSON (backup/versioning/berbagi), atau **Import** snapshot. State juga tersimpan otomatis di database/`data/` tiap perubahan.
- **Twin Synchronization Center** — **Revert to Certified State**: kembalikan seluruh topologi/rule/NAT/audit/change ke kondisi awal (data demo/seed).
- **Factory Reset (Kosongkan Twin)** — hapus permanen **semua data twin** (device beserta route/rule/NAT, kabel, audit, change request, reservasi IPAM) supaya Anda mulai memodelkan jaringan sendiri dari nol tanpa data demo. Akun user, koneksi SSH, profil parser, dan pengaturan engine **tetap**. Konfirmasinya dengan mengetik `RESET`; tidak bisa dibatalkan, jadi export snapshot dulu bila perlu. Twin tetap kosong setelah restart.
- **User Management** — tambah user (username, password ≥6, role), ubah role, reset password, hapus user. Ada proteksi: tidak bisa menghapus/menurunkan **admin terakhir** atau menghapus akun sendiri.
- **Keamanan Akun (2FA)** — semua role. Aktifkan: masukkan password → pindai QR code (Google Authenticator dsb.) → masukkan kode 6 digit → simpan 10 kode cadangan (salin/unduh; hanya tampil sekali). Matikan: password + kode (atau kode cadangan). Peringatan muncul bila kode cadangan tinggal ≤ 3.
- **User Management → Reset 2FA** (admin) — untuk user lain yang kehilangan HP; user tersebut lalu login dengan password saja dan bisa mendaftar ulang.

---

## 13. Referensi format Parser Profile

Sebuah profile adalah objek JSON:

| Field | Wajib | Keterangan |
|---|---|---|
| `id` | ✓ | Pengenal unik (mis. `"mikrotik"`). |
| `name` | ✓ | Nama tampilan. |
| `detect` | ✓ | Array regex; makin banyak yang cocok pada config, makin tinggi skor auto-detect. |
| `rules` | ✓ | Array aturan ekstraksi (lihat bawah). |
| `boundary` | – | Regex penanda akhir blok (mis. `"^!"` untuk Cisco, `"^(next\|end)$"` untuk FortiGate). Mem-pop konteks terdalam. |
| `statics` | – | Tabel lookup statis: `{ namaTabel: { kunci: nilai } }` (mis. builtin service → port, action map). |
| `builtin` | – | Ditandai server untuk profile bawaan; tidak bisa dihapus (hanya reset). |

**Jenis aturan (`rules[]`)** — tiap aturan punya `match` (regex terhadap baris yang sudah di-`trim`), opsional `context` (hanya aktif di dalam konteks tertentu), lalu **satu** aksi:

| Aksi | Fungsi |
|---|---|
| `push: { id, keyGroup? }` | Masuk konteks (blok). `keyGroup` = grup capture yang jadi kunci instance (mis. nama interface). |
| `pop: "ctxId"` | Keluar konteks. |
| `setHostname: <expr>` | Set hostname. |
| `addVrf: <expr>` | Tambah nama VRF. |
| `table: { name, keyGroup? \| keyCtx?, value }` | Bangun entri tabel lookup (kunci dari grup capture atau kunci konteks). |
| `accumulate: { context? \| key?, target, fields, activate? }` | Kumpulkan field satu record yang tersebar di banyak baris. `context` = record milik konteks blok (di-emit saat pop); `key` = record global ber-kunci (di-emit di akhir; untuk config gaya `set`). `activate:false` = isi field tapi jangan picu emit sendirian. |
| `emit: { target, fields }` | Hasilkan satu record dari satu baris. |

`target` ∈ `interfaces` \| `routes` \| `firewallRules` \| `natMappings`.

**FieldExpr** (nilai sebuah field) bisa berupa:

| Bentuk | Arti |
|---|---|
| `"$1"` | Isi grup capture ke-1. |
| `"teks"` atau `{ "lit": "teks" }` | Literal. |
| `{ "group": 2 }` | Grup capture ke-2. |
| `{ "ctx": "acl" }` | Kunci konteks aktif ber-id `acl`. |
| `{ "concat": [a, b], "sep": "" }` | Gabungkan (default pemisah spasi). |
| `{ "transform": "maskToCidr", "arg": <expr> }` | Terapkan transform. |
| `{ "resolve": "tabel", "arg": <expr>, "fallback": <expr> }` | Cari `arg` di tabel/statics; bila tak ada pakai `fallback`. |

**Transform tersedia:** `maskToCidr` (`"ip mask"`→CIDR), `wildcardToCidr` (`"net wildcard"`→CIDR, untuk ACL Cisco), `ciscoAddr` (`any`/`host X`/`net wildcard`→CIDR), `toCidr32` (tambah `/32`), `protoName` (`ip`→`any`), `lower`, `upper`.

**Tabel bawaan engine (otomatis, tersedia di fase resolusi):**
- `__if` — nama interface → IP (untuk NAT/PAT yang butuh IP interface egress).
- `__zoneip` — zona/VRF → IP interface (untuk source-NAT interface Junos, dll).

> Tip: config **gaya per-baris** (`set ...` seperti Junos/PAN-OS/MikroTik) paling mudah — cukup `emit`/`accumulate key`. Config **gaya blok** (Cisco `interface.../!`, FortiGate `config...edit...next`) butuh `push/pop` + `boundary`. Empat vendor bawaan adalah contoh referensi terbaik — buka definisinya untuk meniru polanya.

---

## 14. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Simulasi berhenti "No Route" di sebuah device | Route ke tujuan tidak ada, **atau next-hop tidak ter-resolve** ke subnet interface mana pun. Cek routing table & apakah interface next-hop benar. Ini perilaku benar (engine tidak menebak). |
| Simulasi berhenti dan tidak berpindah antar device | Belum ada **kabel (link)**. Tambahkan di Inventory → Physical Links. |
| Trafik yang seharusnya boleh malah "Blocked by implicit deny" | Belum ada rule permit yang cocok, atau **urutan rule** salah. Cek Firewall Rule Manager (first-match), atau matikan implicit deny di Settings untuk uji. |
| Import config: hasil kosong / peringatan "tidak menemukan apa pun" | Vendor salah, atau dialek config beda. Pilih vendor tepat, atau sesuaikan aturan di Parser Profiles + Live Test. |
| Tombol simpan/settings tak bisa diklik | Role Anda bukan admin. Aksi tersebut dibatasi RBAC. |
| "Terlalu banyak percobaan login gagal" | Rate-limit (10 gagal/15 menit/IP). Tunggu beberapa menit. |
| Server produksi menolak start | `JWT_SECRET` kosong, kurang dari 16 karakter, atau masih nilai contoh (mis. `change-me-in-production`). Isi dengan `openssl rand -hex 32`. |
| `docker compose up` gagal "Set JWT_SECRET in .env" | Buat file `.env` (salin dari `.env.example`) dan isi `JWT_SECRET`. |
| Login berhasil tapi langsung kembali ke layar login | Browser menolak cookie. Jangan set `COOKIE_SECURE=true` bila aplikasi diakses via HTTP biasa; di belakang reverse proxy HTTPS set `TRUST_PROXY=1`. |
| "… was changed by someone else since you loaded it" | Pengguna lain menyimpan device yang sama lebih dulu. Data terbaru otomatis dimuat ulang — ulangi perubahan Anda. |
| SSH Sync: "CRED_KEY is not configured" | `CRED_KEY` belum di-set / terlalu pendek / masih nilai contoh. Bila `CRED_KEY` diganti, password perangkat yang tersimpan tidak bisa dibuka lagi — isi ulang di menu SSH Sync. |
| Perubahan hilang setelah restart (mode dev) | Pastikan folder `data/` bisa ditulis; state tersimpan di `data/*.json`. Dengan Docker, data ada di volume MySQL `db_data`. File JSON yang rusak dipindah ke `*.corrupt-<waktu>` (tidak ditimpa) agar bisa dipulihkan manual. |
| Kode 2FA selalu ditolak | Pastikan jam HP otomatis/akurat (toleransi ±30 detik) dan pakai kode yang sedang tampil; kode yang sudah dipakai tidak diterima lagi. Kalau `JWT_SECRET` baru saja diganti, pakai kode cadangan lalu daftar ulang. |
| Kehilangan HP 2FA | Login dengan kode cadangan, atau minta admin **Reset 2FA**. Admin tunggal tanpa kode cadangan: lihat "Pemulihan darurat" di README. |

Butuh mengembalikan semuanya ke kondisi awal? **Settings → Revert to Certified State** (twin kembali ke data demo) dan **Parser Profiles → Reset profile bawaan** (parser). Ingin twin benar-benar kosong? **Settings → Factory Reset (Kosongkan Twin)**.
