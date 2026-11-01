# aiERP kasa — desktop aplikacija

Electron aplikacija za Windows i macOS: prozor aiERP-a s mostom do fiskalnog uređaja (bez zasebnih ekrana za rad).
Aktuelna dokumentacija (verzija, ugovor mosta, prava, ažuriranje, potpisivanje certifikatom) je u `CLAUDE.md`;
ostatak ovog fajla je stari opis builda.

> Instalacija i exe NISU potpisani certifikatom (vanjski korak — vidi `CLAUDE.md`, „Prava, ažuriranje i potpis").

## Preduvjeti (i Windows i macOS)

1. **Node.js 20 LTS** → https://nodejs.org
2. **Python 3.8+** → https://python.org (za generisanje ikona)

---

## Build na WINDOWS → .exe installer

```
Dvoklik na:  BUILD-WINDOWS.bat
```

Čeka se ~3-5 minuta (prva instalacija Electron paketa).  
Rezultat: `dist/STT HR Setup 1.0.0.exe`

---

## Build na macOS → .dmg

```bash
chmod +x BUILD-MAC.sh
./BUILD-MAC.sh
```

Rezultat: `dist/STT HR-1.0.0.dmg`

> **Napomena za macOS:** Za Intel Mac i Apple Silicon (M1/M2/M3) — build automatski pravi oba (x64 + arm64).

---

## Struktura projekta

```
stt-hr-electron/
├── main.js              # Electron entry point
├── package.json         # Konfiguracija + build settings
├── app/
│   └── index.html       # Kompletna HR aplikacija
├── build/
│   ├── icon.svg         # STT logo (source)
│   ├── icon.ico         # Generisano za Windows
│   ├── icon.icns        # Generisano za macOS
│   └── icon.png         # Generisano za titlebar
├── scripts/
│   └── make_icons.py    # Konverzija SVG → ico/icns
├── BUILD-WINDOWS.bat    # Build za Windows
└── BUILD-MAC.sh         # Build za macOS
```

---

## Brzi test (bez builda)

```bash
npm install
npm start
```

Pokreće app direktno u development modu.

---

## Ažuriranje aplikacije

Zamijeni `app/index.html` novom verzijom i ponovi build.
