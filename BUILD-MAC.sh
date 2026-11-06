#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Vault aiERP — Build za macOS (.dmg) ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Provjeri Node.js
if ! command -v node &> /dev/null; then
    echo "[GREŠKA] Node.js nije instaliran!"
    echo "Preuzmi sa: https://nodejs.org  (preporučeno: 20 LTS)"
    echo "Ili via Homebrew:  brew install node"
    exit 1
fi

# Ikone (build/icon.png, icon.ico, icon_*.png) su commitane — generišu se samo kad se znak promijeni:
#   node scripts/ikone.js   (treba Playwright, vidi komentar u skripti)

echo "[1/3] Instaliram Node pakete..."
npm install

echo ""
echo "[2/3] Buildam macOS .dmg..."
npm run build:mac

echo ""
echo "[3/3] Gotovo!"
echo ""
echo "  ✅ DMG se nalazi u: dist/"
echo "     Traži fajl:  Vault-aiERP-X.X.X-<arh>.dmg"
echo ""
echo "  Otvori DMG, prevuci aplikaciju u Applications,"
echo "  i testiraj iz Launchpada!"
echo ""
