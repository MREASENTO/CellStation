"""Detached portable updater; replaces application files and preserves data/ intact."""
from pathlib import Path, PurePosixPath
import os,sys,json,time,hashlib,zipfile,shutil,subprocess,stat,ctypes
import re

def safe_app_path(name):
    if not isinstance(name,str) or not name or any(c in name for c in ['\\',':','\x00']):return False
    parts=name.split('/')
    if any(not p or p in ('.','..') or p.endswith(('.',' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in parts):return False
    return name in ('README.txt','PACKAGE_MANIFEST.json') or (name.startswith('resources/app/') and parts[2].lower()!='runtime')

def app_manifest(raw,version,runtime_id,expected_hash=None):
    if len(raw)>2*1024**2 or (expected_hash and hashlib.sha256(raw).hexdigest()!=expected_hash):raise ValueError('App manifest checksum mismatch')
    m=json.loads(raw)
    if m.get('product')!='CellStation' or m.get('kind')!='app' or m.get('version')!=version or m.get('runtimeId')!=runtime_id or m.get('accountDataIncluded') is not False:raise ValueError('App manifest mismatch')
    files=m.get('files')
    if not isinstance(files,dict) or not 1<=len(files)<=20000 or 'resources/app/package.json' not in files or 'PACKAGE_MANIFEST.json' not in files:raise ValueError('App files incomplete')
    seen=set()
    for name,digest in files.items():
        if not safe_app_path(name) or name.lower() in seen or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('Unsafe app file')
        seen.add(name.lower())
    return m

def validate_app_archive(archive,version,runtime_id,manifest_hash,install=None):
    if not re.fullmatch('[a-f0-9]{64}',runtime_id) or not re.fullmatch('[a-f0-9]{64}',manifest_hash):raise ValueError('Invalid signed app metadata')
    with zipfile.ZipFile(archive) as z:
        names=set();files=set();total=0
        for item in z.infolist():
            p=PurePosixPath(item.filename)
            if '\\' in item.filename or p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='CellStation-win32-x64' or any(':' in part for part in p.parts):raise ValueError('Unsafe ZIP path')
            normalized='/'.join(p.parts).lower()
            if normalized in names or stat.S_ISLNK(item.external_attr>>16):raise ValueError('Duplicate or linked ZIP entry')
            names.add(normalized);total+=item.file_size
            if total>128*1024**2:raise ValueError('App update too large')
            if item.is_dir():continue
            relative='/'.join(p.parts[1:])
            if relative!='APP_UPDATE_MANIFEST.json' and not safe_app_path(relative):raise ValueError('App update touches runtime or data')
            files.add(relative)
        m=app_manifest(z.read('CellStation-win32-x64/APP_UPDATE_MANIFEST.json'),version,runtime_id,manifest_hash)
        if files!=set(m['files'])|{'APP_UPDATE_MANIFEST.json'}:raise ValueError('Unlisted or missing app update file')
        for name,digest in m['files'].items():
            if hashlib.sha256(z.read('CellStation-win32-x64/'+name)).hexdigest()!=digest:raise ValueError('App file checksum mismatch')
        package=json.loads(z.read('CellStation-win32-x64/resources/app/package.json'))
        bundle=json.loads(z.read('CellStation-win32-x64/PACKAGE_MANIFEST.json'))
        if package.get('version')!=version or bundle.get('version')!=version or bundle.get('runtimeId')!=runtime_id or bundle.get('accountDataIncluded') is not False:raise ValueError('App package mismatch')
    if install:
        previous=json.loads((Path(install)/'APP_UPDATE_MANIFEST.json').read_text(encoding='utf-8'))
        app_manifest(json.dumps(previous).encode(),previous.get('version'),runtime_id)
    return m

def long_path(value):
    text=str(value)
    return '\\\\?\\'+text if os.name=='nt' and not text.startswith('\\\\?\\') else text

def no_links(directory):
    directory=Path(long_path(directory))
    if directory.is_symlink() or (hasattr(directory,'is_junction') and directory.is_junction()):raise ValueError('Linked update path rejected')
    for p in directory.rglob('*'):
        if p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()):raise ValueError('Linked child rejected')

def validate_archive(archive,version):
    with zipfile.ZipFile(archive) as z:
        names=set();total=0
        for item in z.infolist():
            p=PurePosixPath(item.filename)
            if '\\' in item.filename or p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!='CellStation-win32-x64' or any(':' in part for part in p.parts):raise ValueError('Unsafe ZIP path')
            relative=p.parts[1:]
            if relative and relative[0].lower() in ('data','.git','work','outputs'):raise ValueError('Update contains user data')
            if stat.S_ISLNK(item.external_attr>>16):raise ValueError('ZIP symlink rejected')
            normalized='/'.join(p.parts).lower()
            if normalized in names:raise ValueError('Duplicate ZIP path')
            names.add(normalized);total+=item.file_size
            if total>4*1024**3:raise ValueError('Expanded update too large')
        manifest=json.loads(z.read('CellStation-win32-x64/PACKAGE_MANIFEST.json'))
        package=json.loads(z.read('CellStation-win32-x64/resources/app/package.json'))
        if manifest.get('version')!=version or package.get('version')!=version or manifest.get('accountDataIncluded') is not False:raise ValueError('Version or package type mismatch')
        if 'cellstation-win32-x64/cellstation.exe' not in names or z.testzip() is not None:raise ValueError('Incomplete update')
    return True

def wait_exit(pid,timeout=120):
    if os.name!='nt':return
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32];kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x100000,False,pid)
    if handle:
        try:
            if kernel.WaitForSingleObject(handle,timeout*1000)!=0:raise TimeoutError('Application did not exit')
        finally:kernel.CloseHandle(handle)

def apply_update(transaction):
    tx=Path(transaction).resolve();params=json.loads(tx.read_text(encoding='utf-8-sig'))
    install=Path(params['install']).resolve();data=Path(params['data']).resolve();archive=Path(params['archive']).resolve()
    if data!=install/'data' or not tx.is_relative_to(data/'updates') or not archive.is_relative_to(data/'updates'):raise ValueError('Unexpected update directories')
    with archive.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
    if digest!=params['sha256']:raise ValueError('Update checksum mismatch')
    partial=params.get('kind','full')=='app'
    if partial:
        incoming=validate_app_archive(archive,params['version'],params['runtimeId'],params['manifestSha256'],install)
        previous=json.loads((install/'APP_UPDATE_MANIFEST.json').read_text(encoding='utf-8'))
    else:validate_archive(archive,params['version'])
    wait_exit(params['pid'])
    no_links(install)
    stage=tx.parent/'staged';backup=tx.parent/'rollback'
    if stage.exists() or backup.exists():raise ValueError('Update transaction already used')
    stage.mkdir();backup.mkdir()
    with zipfile.ZipFile(archive) as z:z.extractall(long_path(stage))
    app=stage/'CellStation-win32-x64';old=[];new=[]
    data_backup=tx.parent/'data-state';data_backup.mkdir()
    data_files=[]
    for source in [data/'desktop-settings.json',data/'updates/settings.json',*(data/'work/manager').glob('*.json')]:
        if source.is_file():
            relative=source.relative_to(data);destination=data_backup/relative;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination);data_files.append(relative)
    log=data/'updates'/'last-update.json'
    health=data/'updates'/'health.json'
    def launch(updated):
        env=os.environ.copy();env['CELLSTATION_UPDATE_NONCE']=params['nonce'] if updated else ''
        env.pop('ELECTRON_RUN_AS_NODE',None)
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        arguments=[str(install/'CellStation.exe'),'--updated' if updated else '--skip-update-once']
        if params.get('background'):arguments.append('--autostart')
        return subprocess.Popen(arguments,cwd=install,env=env,creationflags=flags,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    child=None
    try:
        if partial:
            operations=[]
            for name,digest in incoming['files'].items():
                target=install/name
                if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest()!=digest:operations.append(name)
            operations+=sorted(name for name in previous['files'] if name.lower() not in {n.lower() for n in incoming['files']})
            operations.append('APP_UPDATE_MANIFEST.json')
        else:operations=[item.name for item in app.iterdir()]
        for name in operations:
            item=app/name;destination=install/name;preserved=backup/name
            if destination.exists():
                preserved.parent.mkdir(parents=True,exist_ok=True);shutil.move(str(destination),str(preserved));old.append(name)
            if item.exists():
                destination.parent.mkdir(parents=True,exist_ok=True);shutil.move(str(item),str(destination));new.append(name)
        child=launch(True)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            if health.exists():
                result=json.loads(health.read_text(encoding='utf-8-sig'))
                if result.get('nonce')==params['nonce'] and result.get('version')==params['version']:
                    shutil.rmtree(long_path(backup));shutil.rmtree(long_path(stage));shutil.rmtree(long_path(data_backup));archive.unlink(missing_ok=True)
                    log.write_text(json.dumps({'status':'success','version':params['version'],'at':time.time()}),encoding='utf-8');return
            if child.poll() is not None:raise RuntimeError('Updated application exited before healthy startup')
            time.sleep(.5)
        raise TimeoutError('Updated application did not confirm healthy startup')
    except Exception as error:
        if child and child.poll() is None:child.terminate();child.wait(timeout=20)
        for name in reversed(new):
            target=install/name
            if target.is_dir():shutil.rmtree(long_path(target))
            elif target.exists():target.unlink()
        for name in reversed(old):shutil.move(str(backup/name),str(install/name))
        for relative in data_files:shutil.copy2(data_backup/relative,data/relative)
        log.write_text(json.dumps({'status':'rolled_back','error':str(error),'at':time.time()}),encoding='utf-8')
        launch(False)
        raise

if __name__=='__main__':
    if sys.argv[1]=='--validate-app':validate_app_archive(*sys.argv[2:])
    elif sys.argv[1]=='--validate':validate_archive(sys.argv[2],sys.argv[3])
    else:apply_update(sys.argv[1])
