"""Generate the complete owned application inventory; runtime files stay separate."""
from pathlib import Path
import hashlib,json

def digest(file):
    with file.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()

def is_app(name):
    return name in ('README.txt','PACKAGE_MANIFEST.json') or (name.startswith('resources/app/') and not name.startswith('resources/app/runtime/'))

def runtime_id(bundle):
    # Electron Packager stamps the application version into the launcher EXE.
    # Engine version/DLLs and packaged runtimes define compatibility instead.
    items={p.relative_to(bundle).as_posix():digest(p) for p in bundle.rglob('*') if p.is_file() and p.relative_to(bundle).parts[0]!='data' and not is_app(p.relative_to(bundle).as_posix()) and p.relative_to(bundle).as_posix() not in ('APP_UPDATE_MANIFEST.json','CellStation.exe') and not ('.dist-info' in p.parent.name and p.name in ('RECORD','direct_url.json'))}
    return hashlib.sha256(json.dumps(items,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def write_app_manifest(bundle,version,runtime):
    files={p.relative_to(bundle).as_posix():digest(p) for p in sorted(bundle.rglob('*')) if p.is_file() and is_app(p.relative_to(bundle).as_posix())}
    m={'product':'CellStation','kind':'app','version':version,'runtimeId':runtime,'accountDataIncluded':False,'files':files}
    (bundle/'APP_UPDATE_MANIFEST.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return m
