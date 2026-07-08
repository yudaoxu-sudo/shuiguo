#!/usr/bin/env python3
import re
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("usage: recognize-captcha-ddddocr.py <image>", file=sys.stderr)
        return 2

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        print(f"image not found: {image_path}", file=sys.stderr)
        return 2

    try:
        import ddddocr
    except Exception as exc:
        print(f"ddddocr import failed: {exc}", file=sys.stderr)
        return 3

    ocr = ddddocr.DdddOcr(show_ad=False)
    code = ocr.classification(image_path.read_bytes())
    code = re.sub(r"[^A-Za-z0-9]", "", str(code or ""))
    if not 4 <= len(code) <= 6:
        print(f"invalid code: {code}", file=sys.stderr)
        return 4

    print(code)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
