#!/usr/bin/env python3
"""
Konvertuje STT logo SVG u .ico (Windows) i .icns (macOS)
Pokreni JEDNOM prije build-a:  python scripts/make_icons.py
"""

import subprocess
import sys
import os
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).parent.parent
BUILD = ROOT / "build"

def install_if_missing(pkg):
    try:
        __import__(pkg.replace("-","_"))
    except ImportError:
        print(f"Instaliram {pkg}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])

def make_png_from_svg(svg_path, out_png, size):
    """Konvertuje SVG u PNG zadane veličine."""
    # Pokušaj cairosvg (best quality)
    try:
        install_if_missing("cairosvg")
        import cairosvg
        cairosvg.svg2png(
            url=str(svg_path),
            write_to=str(out_png),
            output_width=size,
            output_height=size,
            background_color="#1a56db"  # plava pozadina za ikonu
        )
        return True
    except Exception as e:
        print(f"cairosvg failed ({e}), pokušavam Pillow+resvg...")

    # Fallback: Pillow direktno iz SVG (limitirano)
    try:
        install_if_missing("Pillow")
        from PIL import Image, ImageDraw
        # Ako SVG konverzija ne radi, napravi placeholder
        img = Image.new("RGBA", (size, size), (26, 86, 219, 255))
        draw = ImageDraw.Draw(img)
        # Napiši "STT" tekst kao fallback
        draw.rectangle([size//8, size//8, size*7//8, size*7//8], outline="white", width=max(2, size//30))
        img.save(str(out_png))
        return True
    except Exception as e2:
        print(f"Pillow fallback failed: {e2}")
        return False

def make_ico(png_paths_by_size, out_ico):
    """Pakuje više PNG-ova u .ico fajl."""
    install_if_missing("Pillow")
    from PIL import Image

    images = []
    for size, png_path in sorted(png_paths_by_size.items()):
        img = Image.open(png_path).convert("RGBA")
        img = img.resize((size, size), Image.LANCZOS)
        images.append(img)

    # Snimi kao ICO sa svim veličinama
    images[0].save(
        str(out_ico),
        format="ICO",
        sizes=[(img.width, img.height) for img in images],
        append_images=images[1:]
    )
    print(f"  ✓ {out_ico.name}")

def make_icns(png_paths_by_size, out_icns):
    """
    Pravi .icns za macOS.
    Koristi 'iconutil' ako smo na macOS, inače pakuje ručno.
    """
    import platform
    if platform.system() == "Darwin":
        # macOS: koristi iconutil (native, best quality)
        iconset = BUILD / "icon.iconset"
        iconset.mkdir(exist_ok=True)
        mapping = {
            16: "icon_16x16.png",
            32: "icon_16x16@2x.png",
            32: "icon_32x32.png",
            64: "icon_32x32@2x.png",
            128: "icon_128x128.png",
            256: "icon_128x128@2x.png",
            256: "icon_256x256.png",
            512: "icon_256x256@2x.png",
            512: "icon_512x512.png",
            1024: "icon_512x512@2x.png",
        }
        install_if_missing("Pillow")
        from PIL import Image
        for size, fname in mapping.items():
            src = png_paths_by_size.get(size) or png_paths_by_size.get(max(png_paths_by_size.keys()))
            img = Image.open(src).convert("RGBA").resize((size, size), Image.LANCZOS)
            img.save(str(iconset / fname))
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out_icns)], check=True)
        print(f"  ✓ {out_icns.name} (via iconutil)")
    else:
        # Windows/Linux: kopiraj 512px PNG kao .icns placeholder
        # electron-builder na macOS će ga konvertirati u prave ICNS
        import shutil
        biggest = png_paths_by_size[max(png_paths_by_size.keys())]
        shutil.copy(biggest, out_icns)
        print(f"  ✓ {out_icns.name} (PNG placeholder - finalni build radi se na macOS)")

def main():
    print("=== STT HR — Generisanje ikona ===\n")
    svg = BUILD / "icon.svg"
    if not svg.exists():
        print(f"ERROR: Nije pronađen {svg}")
        sys.exit(1)

    sizes = [16, 32, 48, 64, 128, 256, 512]
    pngs = {}

    print("Konvertujem SVG → PNG veličine...")
    for size in sizes:
        out = BUILD / f"icon_{size}.png"
        if make_png_from_svg(svg, out, size):
            pngs[size] = out
            print(f"  ✓ {size}×{size}px")
        else:
            print(f"  ✗ {size}×{size}px FAILED")

    if not pngs:
        print("\nERROR: Nijedna PNG konverzija nije uspjela.")
        sys.exit(1)

    # Kopiraj 512px kao icon.png (za Electron titlebar)
    import shutil
    biggest = pngs[max(pngs.keys())]
    shutil.copy(biggest, BUILD / "icon.png")
    print(f"  ✓ icon.png")

    print("\nPravim icon.ico (Windows)...")
    make_ico(pngs, BUILD / "icon.ico")

    print("\nPravim icon.icns (macOS)...")
    make_icns(pngs, BUILD / "icon.icns")

    print("\n✅ Gotovo! Ikone su u build/ folderu.")
    print("   Nastavi sa: npm run build:win   (na Windows)")
    print("               npm run build:mac   (na macOS)")

if __name__ == "__main__":
    main()
