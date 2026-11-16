#!/usr/bin/env python3
"""Extract the classic 5x7 font table from Adafruit_GFX's glcdfont.c and emit it
as a hex string for embedding in web/index.html.

Usage: extract_font.py <path/to/glcdfont.c> [--inject web/index.html]
With --inject, the text between the FONT_HEX markers in index.html is replaced.
"""
import re, sys

def load(path):
    src = open(path, encoding="utf-8").read()
    body = re.search(r"font\[\]\s*PROGMEM\s*=\s*\{(.*?)\};", src, re.S).group(1)
    body = re.sub(r"//.*", "", body)
    vals = [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]{2})", body)]
    return vals

def main():
    vals = load(sys.argv[1])
    assert len(vals) == 1280, f"expected 1280 bytes (256 glyphs x 5), got {len(vals)}"
    hexstr = "".join(f"{v:02x}" for v in vals)
    lines = [hexstr[i:i + 100] for i in range(0, len(hexstr), 100)]
    block = "const FONT_HEX =\n" + "\n".join(f'  "{l}"' + ("" if i == len(lines) - 1 else " +") for i, l in enumerate(lines)) + ";"
    if "--inject" in sys.argv:
        target = sys.argv[sys.argv.index("--inject") + 1]
        html = open(target, encoding="utf-8").read()
        new = re.sub(r"(// BEGIN FONT_HEX\n).*?(\n\s*// END FONT_HEX)",
                     lambda m: m.group(1) + block + m.group(2), html, flags=re.S)
        assert new != html or block in html, "FONT_HEX markers not found"
        open(target, "w", encoding="utf-8").write(new)
        print(f"injected {len(vals)} bytes into {target}")
    else:
        print(block)

if __name__ == "__main__":
    main()
