# MiDoc — Studio Dokumen & Gambar

Website statis satu halaman untuk alat PDF, gambar, konversi, dan utilitas. Aplikasi berjalan langsung di browser melalui `index.html`.

## GitHub Pages

1. Buka **Settings → Pages** pada repository.
2. Pada **Build and deployment → Source**, pilih **GitHub Actions**.
3. Buka tab **Actions** dan pastikan workflow **Deploy MiDoc to GitHub Pages** berjalan hingga berhasil.
4. Website akan tersedia di:

   https://miuskyyy.github.io/MiDoc/

Setiap push ke branch `main` akan menerbitkan ulang website secara otomatis. Workflow juga dapat dijalankan secara manual melalui **Actions → Deploy MiDoc to GitHub Pages → Run workflow**.

## Catatan

- Tidak membutuhkan Node.js, npm, framework, atau backend untuk publikasi statis.
- Beberapa library dan font dimuat dari CDN, sehingga browser memerlukan koneksi internet untuk memuat dependensi tersebut.
- Pemrosesan file pada aplikasi ini dilakukan di browser. Jangan menyimpan API key atau secret di HTML karena repository dan website ini bersifat publik.
