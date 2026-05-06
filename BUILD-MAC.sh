#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   STT HR — Build za macOS (.dmg)     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Provjeri Node.js
if ! command -v node &> /dev/null; then
    echo "[GREŠKA] Node.js nije instaliran!"
    echo "Preuzmi sa: https://nodejs.org  (preporučeno: 20 LTS)"
    echo "Ili via Homebrew:  brew install node"
    exit 1
fi

# Provjeri Python
if ! command -v python3 &> /dev/null; then
    echo "[GREŠKA] Python3 nije instaliran!"
    echo "Preuzmi sa: https://python.org"
    echo "Ili via Homebrew:  brew install python"
    exit 1
fi

echo "[1/4] Instaliram Node pakete..."
npm install

echo ""
echo "[2/4] Generiram ikone..."
python3 scripts/make_icons.py || echo "[UPOZORENJE] Ikone nisu generirane, nastavlja se..."

echo ""
echo "[3/4] Buildam macOS .dmg..."
npm run build:mac

echo ""
echo "[4/4] Gotovo!"
echo ""
echo "  ✅ DMG se nalazi u: dist/"
echo "     Traži fajl:  STT HR-X.X.X.dmg"
echo ""
echo "  Otvori DMG, prevuci aplikaciju u Applications,"
echo "  i testiraj iz Launchpada!"
echo ""
