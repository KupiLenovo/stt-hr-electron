# Vault aiERP — Desktop aplikacija

Electron aplikacija za Windows i macOS (tanak omotač: UI dolazi sa servera firme; desktop dodaje fiskalni
printer, offline kasu i auto-update). Detalji: `CLAUDE.md` i `UPUSTVO-ZA-INSTALACIJU.txt`.

## Preduvjeti

1. **Node.js 20 LTS** → https://nodejs.org

---

## Build na WINDOWS → .exe installer

```
Dvoklik na:  BUILD-WINDOWS.bat
```

Rezultat: `dist/Vault-aiERP-Setup-X.Y.Z.exe`

---

## Build na macOS → .dmg

```bash
chmod +x BUILD-MAC.sh
./BUILD-MAC.sh
```

Rezultat: `dist/Vault-aiERP-X.Y.Z-<arh>.dmg` (x64 i arm64).

---

## Struktura projekta

```
stt-hr-electron/
├── main.js              # Electron main process
├── preload.js           # most prema rendereru (sandbox)
├── povezivanje.html     # ekran „Šifra firme"
├── offline.html         # „Nema veze sa serverom"
├── package.json         # konfiguracija + build postavke
├── build/
│   ├── icon.svg         # Vault aiERP ikona — znak „Dvije trake" (izvor)
│   ├── icon.ico         # generisano za Windows
│   ├── icon.png         # generisano (1024) za macOS i naslovnu traku
│   └── icon_*.png       # generisano (16–1024)
├── scripts/
│   └── ikone.js         # SVG → PNG/ICO (Playwright), pokreće se samo kad se znak promijeni
├── BUILD-WINDOWS.bat    # build za Windows
└── BUILD-MAC.sh         # build za macOS
```

---

## Brzi test (bez builda)

```bash
npm ci
npm start
npm test
```
