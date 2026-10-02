import React, { createContext, useContext, useEffect, useState } from 'react';

export type Lang = 'en' | 'id';

const STORE_KEY = 'nettwin_lang';

// gettext-style: the English string is the key AND the default. The `id` map
// below provides the Indonesian override. Any string without an entry falls
// back to English, so a missing translation degrades gracefully (never breaks).
const ID: Record<string, string> = {
  // --- chrome / nav ---
  'Control Plane Twin': 'Control Plane Twin',
  'Simulate & Analyze': 'Simulasi & Analisis',
  'Configure & Synchronize': 'Konfigurasi & Sinkronisasi',
  'Path Simulator': 'Simulator Jalur',
  'Global Topology': 'Topologi Global',
  'Compliance Auditor': 'Auditor Kepatuhan',
  'Change Request Center': 'Pusat Change Request',
  'Devices & VRF Inventory': 'Inventaris Device & VRF',
  'NAT Terminologies': 'Terminologi NAT',
  'Config Importer': 'Impor Konfigurasi',
  'Parser Profiles': 'Profil Parser',
  'Simulator Settings': 'Pengaturan Simulator',
  'Digital Twin Console': 'Konsol Digital Twin',
  'Control Plane Status:': 'Status Control Plane:',
  'Online': 'Online',
  'Devices Synchronized:': 'Device Tersinkron:',
  '{count} nodes': '{count} node',
  'Logout': 'Keluar',
  'Language': 'Bahasa',

  // --- loading / auth ---
  'Checking session...': 'Memeriksa sesi...',
  'Initializing NetTwin Core...': 'Menginisialisasi NetTwin Core...',
  'Synchronizing digital twin control plane states': 'Menyinkronkan state control plane digital twin',
  'Sign in to Digital Twin Console': 'Masuk ke Konsol Digital Twin',
  'Username': 'Nama pengguna',
  'Password': 'Kata sandi',
  'Sign In': 'Masuk',
  'Login failed': 'Login gagal',
  'Access denied: your role does not have permission for this action.': 'Akses ditolak: role Anda tidak memiliki izin untuk aksi ini.',

  // --- common ---
  'Save': 'Simpan',
  'Cancel': 'Batal',
  'Delete': 'Hapus',
  'Add': 'Tambah',
  'Edit': 'Edit',
  'Reset': 'Reset',
  'Apply': 'Terapkan',
  'New': 'Baru',
  'Test': 'Uji',
  'none': 'tidak ada',
  'Type': 'Tipe',
  'Status': 'Status',
  'Router': 'Router',
  'Firewall': 'Firewall',
  'Switch': 'Switch',
  'Host': 'Host',
  'read-only': 'baca-saja',
  'Save Changes': 'Simpan Perubahan',
  'Actions': 'Aksi',
  'You': 'Anda',
  'Role': 'Role',

  // --- SSH Sync ---
  'SSH Sync': 'Sinkronisasi SSH',
  'Device Connections': 'Koneksi Perangkat',
  'SSH collector sidecar is not configured. Run the app via docker-compose (which starts the collector). Manual config upload still works normally.':
    'Sidecar collector SSH belum dikonfigurasi. Jalankan aplikasi via docker-compose (yang menyalakan collector). Upload config manual tetap berfungsi normal.',
  'CRED_KEY is not set — set it before storing device credentials in production.':
    'CRED_KEY belum di-set — set dulu sebelum menyimpan kredensial perangkat di produksi.',
  'Edit connection': 'Edit koneksi',
  'New connection': 'Koneksi baru',
  'Name (e.g. Core-R1)': 'Nama (mis. Core-R1)',
  'Mgmt IP': 'IP Management',
  'Read-only username': 'Username read-only',
  'Password (leave blank to keep)': 'Password (kosongkan untuk menjaga)',
  'Target: new device': 'Target: device baru',
  'Target: merge into': 'Target: gabung ke',
  'Save connection': 'Simpan koneksi',
  'Failed to save connection': 'Gagal menyimpan koneksi',
  'Connection saved.': 'Koneksi tersimpan.',
  'Delete connection "{name}"?': 'Hapus koneksi "{name}"?',
  'Connection deleted.': 'Koneksi dihapus.',
  'Collection failed': 'Koleksi gagal',
  'Collect now': 'Tarik sekarang',
  'No connections yet. Add a read-only SSH connection to a device.': 'Belum ada koneksi. Tambahkan koneksi SSH read-only ke perangkat.',
  'Pick a connection and click "Collect now" to pull read-only data (config, routes, ARP, LLDP/CDP) and preview the drift vs your twin.':
    'Pilih koneksi lalu klik "Tarik sekarang" untuk menarik data read-only (config, route, ARP, LLDP/CDP) dan lihat drift dibanding twin Anda.',
  'Collected': 'Terkumpul',
  'Drift vs twin': 'Drift vs twin',
  'new device': 'device baru',
  'Interfaces': 'Interface',
  'Routes': 'Route',
  'ACL / Policy': 'ACL / Policy',
  'ARP hosts': 'Host ARP',
  'Neighbors': 'Neighbor',
  'Routes (RIB)': 'Route (RIB)',
  'Routes (from config)': 'Route (dari config)',
  'ARP (live hosts)': 'ARP (host live)',
  'Neighbors (LLDP/CDP)': 'Neighbor (LLDP/CDP)',
  'Add ARP hosts to IPAM': 'Tambahkan host ARP ke IPAM',
  'Auto-cable from neighbors': 'Auto-kabel dari neighbor',
  'Apply to Digital Twin': 'Terapkan ke Digital Twin',
  'Failed to apply device': 'Gagal menerapkan device',
  'Applied "{name}" to twin. {arp} ARP reservations, {links} links added.': 'Diterapkan "{name}" ke twin. {arp} reservasi ARP, {links} link ditambahkan.',
  'Host key pinned: {fp}': 'Host key dipin: {fp}',
  'Host key mismatch — collection aborted.': 'Host key tidak cocok — koleksi dibatalkan.',
  '⚠ HOST KEY MISMATCH for {name}. The device SSH key changed since it was pinned — this could mean the device was replaced, or a man-in-the-middle. Only trust the new key if you know the device changed.\n\nTrust the new key and re-collect?':
    '⚠ HOST KEY TIDAK COCOK untuk {name}. Kunci SSH perangkat berubah sejak di-pin — ini bisa berarti perangkat diganti, atau ada man-in-the-middle. Hanya percayai kunci baru jika Anda tahu perangkatnya memang berubah.\n\nPercayai kunci baru dan tarik ulang?',

  // --- IPAM ---
  'IP Allocation (IPAM)': 'Alokasi IP (IPAM)',
  'Subnets': 'Subnet',
  'VLANs': 'VLAN',
  'Subnet': 'Subnet',
  'All VRFs / zones': 'Semua VRF / zona',
  'No VLAN tag': 'Tanpa label VLAN',
  'No subnets found. Add interfaces with a CIDR in Inventory.': 'Belum ada subnet. Tambahkan interface ber-CIDR di menu Inventory.',
  'Select a subnet to see its IP allocation.': 'Pilih subnet untuk melihat alokasi IP-nya.',
  'VRF': 'VRF',
  'Gateway': 'Gateway',
  'used': 'terpakai',
  'free': 'kosong',
  'usable': 'usable',
  'Used': 'Terpakai',
  'Free': 'Kosong',
  'Search IP...': 'Cari IP...',
  'Show free addresses': 'Tampilkan alamat kosong',
  'Next available:': 'Berikutnya tersedia:',
  'note (e.g. Printer)': 'catatan (mis. Printer)',
  'Reserve': 'Reservasi',
  'device': 'device',
  'reserved': 'reservasi',
  'Simulate from this IP': 'Simulasikan dari IP ini',
  'Release reservation': 'Lepas reservasi',
  'Click to fill the reserve form': 'Klik untuk mengisi form reservasi',
  ', showing first {n}': ', menampilkan {n} pertama',
  'Failed to reserve IP': 'Gagal mereservasi IP',
  '{ip} reserved.': '{ip} berhasil direservasi.',
  'Release reservation for {ip}?': 'Lepas reservasi untuk {ip}?',
  'Failed to release': 'Gagal melepas reservasi',
  '{ip} released.': '{ip} berhasil dilepas.',
  'VLAN (optional)': 'VLAN (opsional)',

  // --- Path Simulator ---
  'Auto-detect from Source IP (Recommended)': 'Auto-deteksi dari Source IP (Rekomendasi)',
  'No Source Device needed:': 'Tanpa Perlu Source Device:',
  'You do not need to register/create each host device (PC/Server) in the topology. Just enter any source IP and the digital twin auto-detects the default gateway and simulates its route.':
    'Anda tidak perlu mendaftarkan/membuat tiap host device (PC/Server) di topologi. Cukup masukkan IP asal mana saja, digital twin akan otomatis mendeteksi default gateway dan mensimulasikan rutenya.',
  'Automatic (Auto)': 'Otomatis (Auto)',
  'Bypass Security Policies:': 'Bypass Security Policies:',
  'Ignore firewall Permit/Deny rules to focus purely on routing & NAT flow.': 'Abaikan aturan Permit/Deny firewall agar fokus murni pada routing & NAT flow.',
  'Gateway auto-detected!': 'Gateway Terdeteksi Otomatis!',
  'Source IP': 'Source IP',
  'reaches its default gateway': 'terhubung ke default gateway',
  'in VRF context': 'pada context VRF',
  'The route simulation ran from this segment.': 'Simulasi rute dijalankan mulai dari segmen ini.',

  // --- Inventory ---
  'Add New Device': 'Tambah Device Baru',
  'New Device': 'Device Baru',
  'Device Name': 'Nama Device',
  'Save Device': 'Simpan Device',
  'Delete Device': 'Hapus Device',
  'Remove Device from Twin': 'Hapus Device dari Twin',
  'Are you sure you want to remove device "{name}" from the digital twin topology?': 'Apakah Anda yakin ingin menghapus device "{name}" dari topologi digital twin?',
  'New VRF...': 'VRF baru...',
  'Add VRF': 'Tambah VRF',
  'Delete interface': 'Hapus interface',
  'No interfaces in this VRF yet.': 'Belum ada interface di VRF ini.',
  'Interface "{name}" already exists in this VRF.': 'Interface "{name}" sudah ada di VRF ini.',
  'This interface still has a cable (link) attached. Remove the link first.': 'Interface ini masih terpasang kabel (link). Hapus link-nya terlebih dahulu.',
  'VRF "{name}" already exists on this device.': 'VRF "{name}" sudah ada di device ini.',
  'Physical cables determine which neighbor each egress interface reaches during hop-by-hop simulation.': 'Kabel fisik menentukan neighbor mana yang dituju tiap egress interface saat simulasi hop-by-hop.',
  'Disconnect link': 'Putuskan link',
  'This device is not connected to any other device yet.': 'Device ini belum terhubung ke device lain.',
  'Choose interface...': 'Pilih interface...',
  'Choose device...': 'Pilih device...',
  // firewall rule manager
  'Security Policy Rules': 'Security Policy Rules',
  'Evaluated first-match top to bottom — order sets priority. Use the arrows to reorder.': 'Evaluasi first-match dari atas ke bawah — urutan menentukan prioritas. Gunakan panah untuk reorder.',
  'Add Rule': 'Tambah Rule',
  'Delete this rule from the policy set?': 'Hapus rule ini dari policy set?',
  'Raise priority': 'Naikkan prioritas',
  'Lower priority': 'Turunkan prioritas',
  'Delete rule': 'Hapus rule',
  'No policy rules yet — the firewall forwards all traffic per routing (router behaviour).': 'Belum ada policy rule — firewall meneruskan semua trafik sesuai routing (perilaku router).',
  'implicit deny all (if enabled in Settings)': 'implicit deny all (jika diaktifkan di Settings)',

  // --- Config Importer ---
  'Static Multi-Vendor Config Importer': 'Importer Konfigurasi Multi-Vendor (Statis)',
  "Parsing is 100% local & offline (no AI, no data leaves the server). Each vendor's rules are stored as a": 'Parsing 100% lokal & offline (tanpa AI, tanpa kirim data keluar). Aturan tiap vendor tersimpan sebagai',
  'Parser Profile': 'Parser Profile',
  'you can edit/extend.': 'yang bisa Anda edit/tambah.',
  'Vendor': 'Vendor',
  'Auto-detect': 'Auto-deteksi',
  'Upload Config File': 'Upload File Config',
  'Choose file...': 'Pilih file...',
  'Paste running-config here, or upload a file...\n\nexample:\ninterface GigabitEthernet0/1\n ip address 10.10.1.1 255.255.255.0':
    'Paste running-config di sini, atau upload file...\n\ncontoh:\ninterface GigabitEthernet0/1\n ip address 10.10.1.1 255.255.255.0',
  'Parsing...': 'Memproses...',
  'Parse Config': 'Parse Config',
  'Failed to parse configuration': 'Gagal parsing konfigurasi',
  'Vendor could not be auto-detected. Pick a vendor manually, or create a new parser profile in the Parser Profiles menu.':
    'Vendor tidak terdeteksi otomatis. Pilih vendor secara manual, atau buat parser profile baru di menu Parser Profiles.',
  'New device "{name}" created from config. Connect its cables in the Inventory menu so it can be simulated.':
    'Device baru "{name}" dibuat dari konfigurasi. Sambungkan kabel di menu Inventory agar bisa disimulasikan.',
  'Preview & Correct': 'Preview & Koreksi',
  "Fix wrong values, uncheck what you don't need, then apply.": 'Perbaiki nilai yang salah, hilangkan centang yang tak perlu, lalu apply.',
  'detected:': 'terdeteksi:',
  'Parsing results appear here as an editable table.': 'Hasil parsing akan muncul di sini sebagai tabel yang bisa dikoreksi.',
  'Hostname:': 'Hostname:',
  'ACL / Firewall Policy': 'ACL / Firewall Policy',
  'Create new device': 'Buat device baru',
  'Merge into:': 'Merge ke:',
  'Apply {n} items to Digital Twin': 'Apply {n} item ke Digital Twin',

  // --- Parser Profiles ---
  'Read-only mode. Only admins can edit/save parser profiles.': 'Mode baca-saja. Hanya admin yang dapat mengedit/menyimpan parser profile.',
  'Reset built-in profiles': 'Reset profile bawaan',
  'Profile definition (JSON)': 'Definisi Profile (JSON)',
  'Live Test': 'Live Test',
  'Test parse': 'Test parse',
  'Paste a sample config here to test the profile above...': 'Paste sampel config di sini untuk menguji profile di atas...',
  'Test results appear here. Edit profile → Test → see whether interfaces/routes/ACL/NAT are read correctly.':
    'Hasil test muncul di sini. Edit profile → Test → lihat apakah interface/route/ACL/NAT terbaca benar.',
  'Test failed': 'Test gagal',
  'Invalid JSON: ': 'JSON tidak valid: ',
  'Failed to save': 'Gagal menyimpan',
  'Profile "{name}" saved.': 'Profile "{name}" disimpan.',
  'Delete profile "{id}"?': 'Hapus profile "{id}"?',
  'Failed to delete': 'Gagal menghapus',
  'Profile deleted.': 'Profile dihapus.',
  'Restore all built-in profiles (Cisco/FortiGate/Junos/PAN-OS) to their original definitions? Custom profiles are unaffected.':
    'Kembalikan semua profile bawaan (Cisco/FortiGate/Junos/PAN-OS) ke definisi awal? Profile custom tidak terpengaruh.',
  'Reset failed': 'Reset gagal',
  'Built-in profiles restored to defaults.': 'Profile bawaan dikembalikan ke default.',

  // --- Settings ---
  'Simulation Engine Constraints': 'Batasan Engine Simulasi',
  'These parameters are stored on the server and used by all path simulations, compliance audits, and change-request what-ifs.':
    'Parameter ini tersimpan di server dan dipakai oleh semua simulasi path, audit compliance, dan what-if change request.',
  'Maximum Path Hop Limit (TTL)': 'Batas Maksimum Hop Path (TTL)',
  'Default-Deny Policy Action': 'Aksi Default-Deny Policy',
  'Implicit Drop on Firewall No-match': 'Implicit Drop saat Firewall No-match',
  'Save Engine Settings': 'Simpan Pengaturan Engine',
  'Only admins can change settings': 'Hanya admin yang dapat mengubah settings',
  'Failed to save settings': 'Gagal menyimpan settings',
  'Simulation engine settings saved. All future traces use these values.': 'Pengaturan engine simulasi tersimpan. Semua trace berikutnya memakai nilai ini.',
  'Twin Snapshot (Export / Import)': 'Snapshot Twin (Export / Import)',
  'Twin state is auto-saved to the storage backend on every change. Use snapshots for backup, versioning, or sharing topology with teammates.':
    'State twin tersimpan otomatis ke storage backend setiap ada perubahan. Gunakan snapshot untuk backup, versioning, atau berbagi topology antar rekan.',
  'Export Snapshot (JSON)': 'Export Snapshot (JSON)',
  'Import Snapshot (JSON)': 'Import Snapshot (JSON)',
  'Only admins can import snapshots': 'Hanya admin yang dapat import snapshot',
  'Import failed': 'Import gagal',
  'Import failed: {msg}': 'Import gagal: {msg}',
  'Snapshot imported. Reloading the page for full sync.': 'Snapshot berhasil diimpor. Memuat ulang halaman untuk sinkronisasi penuh.',
  'Twin Synchronization Center': 'Pusat Sinkronisasi Twin',
  'Restore all routes, firewall rules, NAT mappings, audits, and change requests to the initial enterprise reference (seed state) on the server.':
    'Kembalikan semua route, firewall rules, NAT mappings, audits, dan change requests ke kondisi awal enterprise reference (seed state) di server.',
  'Only admins can reset': 'Hanya admin yang dapat reset',
  'Revert to Certified State': 'Kembalikan ke Certified State',
  'Reset the entire topology, rules, NAT, audits, and change requests back to the initial (seed) state? Your changes will be lost.':
    'Kembalikan seluruh topology, rules, NAT, audits, dan change requests ke kondisi awal (seed)? Perubahan Anda akan hilang.',
  'Digital twin successfully reset to the certified seed state.': 'Digital twin berhasil di-reset ke kondisi certified seed.',
  'User Management (RBAC)': 'Manajemen User (RBAC)',
  'full control': 'kontrol penuh',
  'edit twin & draft changes (no approve/settings)': 'edit twin & draft change (tanpa approve/settings)',
  'view & simulate only': 'hanya lihat & simulasi',
  'Change password': 'Ganti password',
  'Delete user': 'Hapus user',
  'New Username': 'Username Baru',
  'Password (min. 6)': 'Password (min. 6)',
  'Add User': 'Tambah User',
  'Failed to create user': 'Gagal membuat user',
  'User "{name}" ({role}) created.': 'User "{name}" ({role}) berhasil dibuat.',
  'Failed to change role': 'Gagal mengubah role',
  'Role for "{name}" changed to {role}.': 'Role "{name}" diubah menjadi {role}.',
  'New password for "{name}" (min. 6 chars):': 'Password baru untuk "{name}" (min. 6 karakter):',
  'Failed to change password': 'Gagal mengubah password',
  'Password for "{name}" changed.': 'Password "{name}" berhasil diganti.',
  'Delete user "{name}"?': 'Hapus user "{name}"?',
  'Failed to delete user': 'Gagal menghapus user',
  'User "{name}" deleted.': 'User "{name}" dihapus.',

  // --- errors, empty states & role notices ---
  'Cannot reach the server. Check your connection and try again.': 'Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.',
  'Request failed (HTTP {status}).': 'Permintaan gagal (HTTP {status}).',
  'This view hit an unexpected error.': 'Tampilan ini mengalami error tak terduga.',
  'The rest of the app still works. Try again, or switch to another menu.': 'Bagian lain aplikasi tetap berfungsi. Coba lagi, atau pindah ke menu lain.',
  'Try again': 'Coba lagi',
  'No devices in the twin yet.': 'Belum ada device di twin.',
  'Use "Add New Device" to create one, or import a config.': 'Gunakan "Tambah Device Baru" untuk membuatnya, atau impor konfigurasi.',
  'New Interface': 'Interface Baru',
  'Configuration merged into device "{name}".': 'Konfigurasi di-merge ke device "{name}".',
  'Importing configurations requires the operator or admin role.': 'Impor konfigurasi memerlukan role operator atau admin.',
  'SSH Sync touches real devices and is limited to admins. Ask an admin to collect from a device.': 'SSH Sync menyentuh perangkat nyata dan hanya untuk admin. Minta admin untuk melakukan collect dari device.',

  // --- in-app dialogs ---
  'OK': 'OK',
  'Confirm': 'Konfirmasi',
  'Notice': 'Informasi',
  'Please confirm': 'Mohon konfirmasi',
  'Input required': 'Isian diperlukan',
  'Type {text} to confirm': 'Ketik {text} untuk konfirmasi',
  'At least {n} characters.': 'Minimal {n} karakter.',
  'Connection problem': 'Masalah koneksi',
  'Access denied': 'Akses ditolak',
  'Conflict': 'Konflik',
  'Action failed': 'Aksi gagal',
  'Release': 'Lepas',
  'Duplicate interface': 'Interface duplikat',
  'Interface in use': 'Interface sedang dipakai',
  'Duplicate VRF': 'VRF duplikat',
  'Delete profile': 'Hapus profil',
  'Delete connection': 'Hapus koneksi',
  'Host key mismatch': 'Host key tidak cocok',
  'Trust new key': 'Percayai key baru',
  'Abort': 'Batalkan',
  'Revert': 'Kembalikan',

  // --- factory reset ---
  'Factory Reset': 'Factory Reset',
  'Factory Reset (Empty Twin)': 'Factory Reset (Kosongkan Twin)',
  'Delete everything': 'Hapus semuanya',
  'Factory reset empties the twin completely (no demo data), so you can model your own network from scratch.': 'Factory reset mengosongkan twin sepenuhnya (tanpa data demo), sehingga Anda bisa memodelkan jaringan sendiri dari nol.',
  'Permanently delete ALL twin data: devices, cables, routes, firewall rules, NAT, audits, change requests and IPAM reservations. User accounts, SSH connections, parser profiles and engine settings are kept. This cannot be undone — export a snapshot first if you may need the data.': 'Hapus permanen SEMUA data twin: device, kabel, route, firewall rule, NAT, audit, change request, dan reservasi IPAM. Akun user, koneksi SSH, profil parser, dan pengaturan engine tetap disimpan. Tindakan ini tidak bisa dibatalkan — export snapshot dulu bila datanya mungkin masih diperlukan.',
  'Factory reset complete. The digital twin is now empty.': 'Factory reset selesai. Digital twin sekarang kosong.',
  // --- two-factor login ---
  'Enter the 6-digit code from your authenticator app, or a recovery code.': 'Masukkan kode 6 digit dari aplikasi authenticator, atau kode cadangan.',
  'Authentication code': 'Kode autentikasi',
  'Verify': 'Verifikasi',
  'Back': 'Kembali',
  'You signed in with a recovery code. {n} left — each works only once.': 'Anda masuk dengan kode cadangan. Tersisa {n} — tiap kode hanya berlaku sekali.',
  'Recovery code used': 'Kode cadangan terpakai',
  // --- account security (2FA) ---
  'Account Security (2FA)': 'Keamanan Akun (2FA)',
  'Protect your account with a 6-digit code from Google Authenticator or a compatible app.': 'Lindungi akun Anda dengan kode 6 digit dari Google Authenticator atau aplikasi sejenis.',
  '2FA on': '2FA aktif',
  '2FA off': '2FA nonaktif',
  'Only {n} recovery codes left. Turn two-factor authentication off and on again to get new ones.': 'Kode cadangan tinggal {n}. Matikan lalu aktifkan lagi 2FA untuk mendapat kode baru.',
  '{n} unused recovery codes.': '{n} kode cadangan belum terpakai.',
  'Turn off 2FA': 'Matikan 2FA',
  'Turn on 2FA': 'Aktifkan 2FA',
  'Current password': 'Password saat ini',
  'Continue': 'Lanjut',
  '1. Scan this QR code with Google Authenticator (or add the key manually).': '1. Pindai QR code ini dengan Google Authenticator (atau masukkan kuncinya secara manual).',
  'QR code for the authenticator app': 'QR code untuk aplikasi authenticator',
  '2. Enter the 6-digit code shown in the app.': '2. Masukkan kode 6 digit yang tampil di aplikasi.',
  'Verify & turn on': 'Verifikasi & aktifkan',
  'Two-factor authentication is on.': '2FA sudah aktif.',
  'Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be shown again.': 'Simpan kode cadangan ini di tempat aman. Tiap kode berlaku sekali bila HP Anda hilang. Kode ini tidak akan ditampilkan lagi.',
  'recovery codes for': 'kode cadangan untuk',
  'Copied': 'Tersalin',
  'Copy': 'Salin',
  'Download .txt': 'Unduh .txt',
  'Done': 'Selesai',
  'Authenticator code or recovery code': 'Kode authenticator atau kode cadangan',
  'Reset 2FA': 'Reset 2FA',
  'Turn off two-factor authentication for "{name}"? They can sign in with their password only until they set it up again.': 'Matikan 2FA untuk "{name}"? User ini bisa masuk hanya dengan password sampai mendaftarkannya lagi.',
  'Failed to reset 2FA': 'Gagal mereset 2FA',
  'Two-factor authentication for "{name}" was reset.': '2FA untuk "{name}" sudah direset.',
};

// Pure translation function (also used directly in tests). English is the
// default; Indonesian comes from the ID map; unknown keys fall back to English.
export function translate(lang: Lang, s: string, vars?: Record<string, string | number>): string {
  let out = lang === 'id' && Object.prototype.hasOwnProperty.call(ID, s) ? ID[s] : s;
  if (vars) {
    for (const k of Object.keys(vars)) {
      // Function replacer: values are user data (device/user names) and must be
      // inserted literally — a string replacement would interpret "$&", "$'"...
      out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(vars[k]));
    }
  }
  return out;
}

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (s: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: s => s });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    // Reading storage throws when site data is blocked; English is the fallback.
    try {
      const stored = localStorage.getItem(STORE_KEY);
      return stored === 'id' || stored === 'en' ? stored : 'en';
    } catch {
      return 'en';
    }
  });

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, lang); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [lang]);

  const t = (s: string, vars?: Record<string, string | number>): string => translate(lang, s, vars);

  return <LanguageContext.Provider value={{ lang, setLang: setLangState, t }}>{children}</LanguageContext.Provider>;
}

export const useLang = () => useContext(LanguageContext);
