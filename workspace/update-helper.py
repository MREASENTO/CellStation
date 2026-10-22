"""Detached portable updater; replaces application files and preserves data/ intact."""
from pathlib import Path, PurePosixPath
import os,sys,json,time,hashlib,zipfile,shutil,subprocess,stat,ctypes

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
    validate_archive(archive,params['version']);wait_exit(params['pid'])
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
        for item in app.iterdir():
            destination=install/item.name
            if destination.exists():shutil.move(str(destination),str(backup/item.name));old.append(item.name)
            shutil.move(str(item),str(destination));new.append(item.name)
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
    if sys.argv[1]=='--validate':validate_archive(sys.argv[2],sys.argv[3])
    else:apply_update(sys.argv[1])
