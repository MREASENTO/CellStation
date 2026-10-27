from pathlib import Path
import hashlib
import json
import zipfile
from app_package import runtime_id,write_app_manifest

root = Path(__file__).resolve().parent.parent
bundle = root / 'outputs' / 'release-v1.0.7' / 'CellStation-win32-x64'
archive = root / 'outputs' / 'CellStation-v1.0.7-win64.zip'
readme = (root / 'workspace' / 'v107-使用说明.txt').read_text(encoding='utf-8-sig')
(bundle / 'README.txt').write_text(readme, encoding='utf-8-sig')
files = [p for p in bundle.rglob('*') if p.is_file() and p.relative_to(bundle).parts[0] != 'data']
manifest = {
    'product': 'CellStation', 'version': '1.0.7', 'platform': 'win32-x64',
    'runtimeId': runtime_id(bundle),
    'accountDataIncluded': False, 'schedulerDefault': 'paused',
    'requirements': ['Windows 64-bit', 'Google Chrome', 'network'],
    'sha256': {name: hashlib.sha256((bundle / name).read_bytes()).hexdigest() for name in ['CellStation.exe','resources/app/workspace/reviews.cjs','resources/app/workspace/git-updates.cjs', 'resources/app/workspace/wechat-notifications.cjs','resources/app/workspace/app-updater.cjs','resources/app/workspace/desktop-updates.cjs','resources/app/workspace/update-helper.py','resources/app/workspace/release-config.json','resources/app/workspace/manager-ui/settings-v100.js','resources/app/workspace/manager-ui/index.html','resources/app/workspace/browser-worker.cjs', 'resources/app/workspace/desktop-integration.cjs', 'resources/app/desktop-main.cjs', 'resources/app/workspace/operations.cjs', 'resources/app/workspace/retention.cjs', 'resources/app/workspace/retention_files.py', 'resources/app/workspace/archive-support.py', 'resources/app/workspace/manager-store.cjs', 'resources/app/workspace/schedule-logic.cjs', 'resources/app/workspace/manager-server.cjs', 'resources/app/workspace/scheduler.cjs', 'resources/app/workspace/reservation.cjs', 'resources/app/workspace/equipment.cjs', 'resources/app/workspace/timeline.cjs', 'resources/app/workspace/manager-ui/app.js', 'resources/app/workspace/manager-ui/style.css']},
}
(bundle / 'PACKAGE_MANIFEST.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
write_app_manifest(bundle,'1.0.7',manifest['runtimeId'])
if not archive.exists():
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=5) as out:
        for file in bundle.rglob('*'):
            if file.is_file() and file.relative_to(bundle).parts[0] != 'data':
                out.write(file, Path(bundle.name) / file.relative_to(bundle))
with zipfile.ZipFile(archive) as check:
    assert not any(name.startswith(bundle.name + '/data/') or name.endswith('/manager-state.json') for name in check.namelist())
    assert json.loads(check.read(bundle.name + '/PACKAGE_MANIFEST.json')) == manifest
    assert check.testzip() is None
print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'crc': 'all files passed', 'privateDataIncluded': False}, ensure_ascii=False))
