"""Run local OCR using project-scoped dependencies; never upload images."""
import argparse
import contextlib
import io
import json
import re
import sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    args = parser.parse_args()
    import ddddocr

    with contextlib.redirect_stdout(io.StringIO()):
        model = ddddocr.DdddOcr(show_ad=False, ocr=True, det=False)
        text = model.classification(args.image.read_bytes()).strip()
    # The currently observed login page uses four Latin letters/digits.
    usable = bool(re.fullmatch(r"[A-Za-z0-9]{4}", text))
    print(json.dumps({"text": text, "usable": usable, "engine": "ddddocr-local"}))


if __name__ == "__main__":
    main()
