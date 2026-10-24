# Panduan mitra: ikut menandatangani keputusan governor YAP

Dokumen ini untuk pihak independen yang akan menjalankan **satu node** dan memegang **satu kunci** dari governor token YAP di Canton. Anda tidak perlu paham Daml. Anda perlu paham tiga hal: apa yang Anda pegang, apa yang harus diperiksa sebelum menyetujui, dan bagaimana menjaga node Anda.

> Status: semua langkah di bagian 3–5 dan 7 sudah dijalankan di testnet dengan dua node (keduanya milik satu operator). Bagian 6 (bergabung ke party yang sudah ada) **belum pernah diuji** dan akan dilatih bersama sebelum dipakai sungguhan. Tidak untuk mainnet sebelum ada audit.

---

## 1. Peran Anda

YAP punya satu pihak penerbit, disebut **governor**. Governor ini adalah *party terdesentralisasi*: bukan satu akun milik satu orang, tetapi satu identitas yang dimiliki beberapa node bersama. Setiap node memegang satu kunci. Sebuah keputusan baru berlaku kalau **jumlah minimum node (threshold) menyetujuinya**.

- Satu node **tidak bisa** bertindak sendirian atas nama governor. Ini sudah diuji: perintah langsung dari satu node ditolak, dan eksekusi dengan kurang dari threshold ditolak oleh ledger.
- Anda **tidak** memegang token siapa pun. Pemilik token (pool, penerima vesting, pengguna) tetap mengendalikan holding mereka.
- Yang diputuskan lewat governor adalah hal yang jarang: mengangkat atau mencabut operator harian, membatalkan vesting yang bisa dicabut, membakar token milik treasury, menyelamatkan holding (mengarsipkannya), mencetak langsung, dan alokasi besar dari treasury.
- Mencetak token baru oleh governor (`GovernorMint`) bertentangan dengan pasokan tetap 100.000.000 YAP. Perlakukan sebagai **tanda bahaya**, lihat bagian 7.

Yang tetap berjalan tanpa Anda: transfer, klaim vesting oleh penerima, pembakaran oleh pemilik. Yang berhenti kalau Anda tidak tersedia (pada susunan 2-dari-2): semua keputusan governor di atas.

## 2. Yang Anda pertaruhkan

- **Ketersediaan.** Kalau node atau kunci Anda hilang dan susunannya 2-dari-2, keputusan governor macet. Susunan 2-dari-3 menghindari ini.
- **Keamanan.** Kalau node Anda dibobol, penyerang memegang satu kunci. Itu belum cukup untuk bertindak, tetapi menurunkan ambang keamanan menjadi satu kunci lagi.
- **Tanggung jawab.** Anda menyetujui keputusan atas nama bersama. Jangan menyetujui apa yang tidak Anda baca.

## 3. Persyaratan

- Sebuah **validator Splice** yang berjalan di jaringan yang sama dengan Canton **3.6.1** (versi bundel Splice 0.9.x, sama dengan node lain). Anda memegang akses root sendiri; tidak ada orang lain, termasuk operator lain, yang boleh punya akses ke node itu.
- Docker dan Docker Compose. 8 GB RAM sudah cukup untuk validator + DecMan.
- SSH hanya dengan kunci, tanpa kata sandi. Firewall aktif.
- Satu port publik untuk DecMan (**9000/TCP, protokol Noise**), dibuka **hanya untuk IP node lain**, bukan untuk semua orang.
- Kanal komunikasi tepercaya dengan operator lain (panggilan video atau pesan terenkripsi) untuk menukar data peer dan memverifikasinya.

## 4. Memasang DecMan di node Anda

Software: **Decentralization Manager** (DLC-Link/BitSafe), open source. Kami memakai image yang dipin ke satu versi dan satu digest:

```
public.ecr.aws/dlc-link/decentralization-manager:v1.13.0-nonroot
sha256:5a00d8b57e3c8187e9d1e4e604a78dc4607bead7eda7c166ca0128e3ddc7d9a9
```

Periksa digest sendiri setelah `docker pull` (`docker image inspect`). Software ini mendapat akses ke Admin API dan Ledger API participant Anda, jadi perlakukan sama seperti software berhak istimewa lain.

Skrip siap pakai ada di repositori ini (`deploy/templates/decman-*.sh.in`; `node deploy/generate.mjs` membuatnya di `deploy/out/`). Jalankan di node Anda, berurutan:

1. `decman-discover-on-vps.sh`: survei hanya-baca (nama jaringan Docker, container participant, port yang dipakai). Tidak mengubah apa pun.
2. `decman-install-on-vps.sh <IP-publik-Anda> <IP-node-lain>`: memasang container DecMan di samping validator. UI hanya di `127.0.0.1:18080`. Port 9000 hanya menerima IP node lain. **Tidak** menyentuh stack validator dan **tidak** me-restart apa pun milik validator.
3. `decman-api-on-vps.sh`: DecMan memercayai klien Keycloak milik validator Anda sendiri, sehingga semua operasi bisa dijalankan dengan `curl` dari server, tanpa membuka UI.
4. `decman-harden-on-vps.sh <IP-node-lain>`: aturan firewall yang bertahan setelah reboot, plus **cadangan terenkripsi** `/opt/decman` (kunci enkripsi database dan kunci Noise ada di sana).

Catatan: skrip mengasumsikan struktur validator Splice yang sama dengan node kami (jaringan Docker `splice-validator_splice_validator`, container `splice-validator-participant-1`). Kalau berbeda, jalankan langkah 1 dulu dan kabari kami hasilnya sebelum lanjut.

## 5. Menukar data peer (penting untuk keamanan)

Setiap node hanya menerima koneksi dari peer yang ada di daftarnya, dan kunci publik Noise peer dipakai untuk handshake. Salah kunci berarti koneksi gagal, dan kunci palsu berarti Anda terhubung ke pihak yang salah.

1. Ambil data Anda: `source /opt/decman/api.sh; api GET /node-config` (ID participant) dan `api GET /keys/status` (kunci publik Noise).
2. Kirim **ID participant, alamat IP publik, port, dan kunci publik Noise** ke operator lain lewat kanal yang terverifikasi. Bacakan **beberapa karakter terakhir kunci** lewat panggilan suara atau video supaya pasti tidak diganti di perjalanan.
3. Tambahkan peer mereka dengan `decman-peers-on-vps.sh` (isinya satu baris data peer per node), lalu periksa `api GET /participants-status`. Status harus `Connected`.

## 6. Bergabung ke party governor (belum diuji)

Alurnya memakai fitur DecMan "add member": operator yang sudah ada memulai prosedur, Anda menerima undangan, lalu setiap node menandatangani perubahan topologi. Setelah itu anggota daftar `GovernanceRules` (yang menentukan siapa yang boleh menyetujui keputusan) diperbarui lewat keputusan governance biasa.

Sebelum menerima undangan apa pun, periksa: **awalan (prefix) party**, **daftar peserta**, dan **threshold baru**. Cocokkan dengan kesepakatan yang sudah dibuat di luar sistem. Kami akan melatih alur ini di testnet bersama Anda sebelum dipakai.

## 7. Menyetujui keputusan: apa yang diperiksa

Setiap keputusan adalah sebuah *proposal*. DecMan hanya menampilkan **judul dan deskripsi pendek**; isi sebenarnya (siapa, berapa, kapan) ada di kontrak di ledger. **Jangan menyetujui hanya dari deskripsi.** Baca isi proposal dari ledger dengan `node scripts/show-allocation-proposal.mjs` (untuk alokasi) atau minta operator mengirim isinya, lalu cocokkan dengan keputusan yang disepakati.

| Label di DecMan | Artinya | Periksa |
|---|---|---|
| `YapAllocate` | Alokasi besar dari treasury ke banyak pool, termasuk jadwal vesting | Setiap item: pool, jumlah, mulai, selesai. Total harus sama dengan angka yang disepakati. Pasokan tetap 100.000.000 |
| `YapGrantVestingFromTreasury` | Satu hibah vesting dari treasury | Penerima, jumlah, jadwal, bisa dicabut atau tidak |
| `YapTreasuryTransfer` | Kirim dari treasury ke satu penerima | Penerima dan jumlah |
| `YapAppointOperator`, `YapSetOperatorAllowance` | Mengangkat atau mengubah batas operator harian | Siapa operatornya, berapa batasnya, sampai kapan |
| `YapRevokeOperator` | Mencabut operator | Memang disepakati |
| `YapRevokeVesting` | Membatalkan hibah (hanya yang ditandai bisa dicabut) | Penerima dan alasannya |
| `YapBurnTreasury` | Membakar token milik treasury | Jumlah, alasan |
| `YapRescueHolding` | Mengarsipkan holding seseorang | **Hanya** dengan alasan tertulis yang jelas (misalnya token dilaporkan dicuri) |
| `YapGovernorMint` | Mencetak token baru | **Tolak**, kecuali ada keputusan tertulis untuk mengubah pasokan tetap |

Aturan umum:

- Konfirmasi **kedaluwarsa dalam 30 menit**. Jangan terburu-buru karena itu.
- Beberapa proposal bisa terbuka bersamaan. Selalu sebut **label**-nya saat mengonfirmasi (`bash decman-vote-on-vps.sh confirm <label>`), jangan mengonfirmasi "yang pertama". Perintah `confirm-all` memakai jeda 15 detik dan menampilkan daftar; pakai hanya kalau semua proposal terbuka sudah Anda periksa.
- Setelah eksekusi, periksa hasilnya: total pasokan harus tetap 100.000.000 YAP, dan saldo pool sesuai yang disepakati.
- Kalau ragu, **jangan konfirmasi**. Tidak mengonfirmasi tidak merugikan siapa pun; proposal akan kedaluwarsa.

## 8. Menjaga node Anda

- Cadangkan `/opt/decman/env`, `/opt/decman/data` (isinya `noise.key` dan database) secara terenkripsi, dan **simpan passphrase di luar server**. Tanpa kunci Noise yang sama, peer harus memperbarui data Anda.
- Jangan membuka UI (`18080`) ke jaringan. Akses lewat terowongan SSH bila perlu.
- Setelah reboot, pastikan `decman-fw.service` aktif dan container `decman` berjalan (`docker ps`). Status peer: `api GET /participants-status`.
- Perbarui DecMan **bersama-sama** dengan operator lain, satu versi untuk semua (versi protokol harus sama), dan hanya ke versi yang disepakati.
- Kalau validator Splice diperbarui, periksa kembali bahwa **autentikasi ledger API tetap aktif**. Pembaruan bundel pernah mengembalikan konfigurasi tanpa autentikasi (kejadian nyata di testnet kami). Uji dengan permintaan tanpa token: harus 401.

## 9. Kalau terjadi masalah

- **Node diduga dibobol:** matikan container `decman`, beri tahu operator lain **segera** lewat kanal terverifikasi, dan jangan menyetujui apa pun sampai selesai. Operator lain akan mencopot node Anda dari party (prosedur "kick") dan mengatur ulang threshold. Anda perlu memasang ulang dari host bersih, bukan "membersihkan" host yang sudah dibobol.
- **Kehilangan kunci atau node:** beri tahu operator lain. Penggantian node adalah prosedur tersendiri (tambah anggota baru, lalu copot yang lama). Karena itu cadangan terenkripsi penting.
- **Ingin keluar:** koordinasikan dengan operator lain. Anggota dicopot lewat prosedur "kick", dan daftar anggota `GovernanceRules` diperbarui.

## 10. Daftar periksa singkat

- [ ] Digest image DecMan cocok, versi sama dengan operator lain
- [ ] Port 9000 hanya terbuka untuk IP node lain; UI tidak terbuka ke jaringan
- [ ] Data peer sudah diverifikasi lewat kanal terpisah; `participants-status` = Connected
- [ ] Cadangan terenkripsi sudah dibuat, passphrase disimpan di luar server
- [ ] Autentikasi ledger API aktif (permintaan tanpa token = 401)
- [ ] Saya tahu cara memeriksa **isi** sebuah proposal, bukan hanya deskripsinya
- [ ] Saya tahu `YapGovernorMint` tidak boleh disetujui tanpa keputusan tertulis
