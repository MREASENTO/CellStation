from pathlib import Path
import sys
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parent))
from retention_files import read_managed

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in ('report.json', 'screenshot.png'):
        file = source / name
        if file.is_file() and not file.is_symlink():
            archive.write(file, name)
        elif name == 'screenshot.png' and len(sys.argv) > 3:
            try:
                root = Path(sys.argv[3]).resolve()
                archive.writestr(name, read_managed(root, file.relative_to(root)))
            except FileNotFoundError:
                pass
