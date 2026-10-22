"""Publish only the signed-inventory application files to the update Git branch."""
from pathlib import Path
import subprocess,sys,json,hashlib,shutil,os
root=Path(__file__).resolve().parent.parent
bundle=Path(sys.argv[1]).resolve();work=root/'work';work.mkdir(exist_ok=True)
repository=work/'app-publish/CellStation';repository.parent.mkdir(exist_ok=True)
remote='https://github.com/MREASENTO/CellStation'
helper=os.environ.get('CELLSTATION_GIT_HELPER','!gh auth git-credential')
def git(*args,check=True):
    return subprocess.run(['git','-c','safe.directory='+repository.as_posix(),'-c','credential.helper=','-c','credential.helper='+helper,'-C',str(repository),*args],check=check,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if not repository.exists():
    repository.mkdir();git('init','-b','app-stable');git('config','core.autocrlf','false')
    refs=git('ls-remote',remote,'refs/heads/app-stable').stdout.strip()
    if refs:git('fetch','--depth=1','--no-tags',remote,'refs/heads/app-stable');git('checkout','-B','app-stable','FETCH_HEAD')
git('config','user.name','CellStation Release');git('config','user.email','71264198+MREASENTO@users.noreply.github.com')
raw=(bundle/'APP_UPDATE_MANIFEST.json').read_bytes();manifest=json.loads(raw)
version=manifest['version'];assert manifest['accountDataIncluded'] is False
sys.path.insert(0,str(root/'workspace'))
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('helper',root/'workspace/update-helper.py');module=module_from_spec(spec);spec.loader.exec_module(module)
module.app_manifest(raw,version,manifest['runtimeId'])
for name in git('ls-files','-z').stdout.decode().split('\0'):
    if not name:continue
    target=repository/name
    assert target.resolve().is_relative_to(repository.resolve()) and not target.is_symlink()
    if target.is_file():target.unlink()
for name,digest in manifest['files'].items():
    source=bundle/name;assert source.is_file() and not source.is_symlink() and hashlib.sha256(source.read_bytes()).hexdigest()==digest
    target=repository/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
(repository/'APP_UPDATE_MANIFEST.json').write_bytes(raw)
git('add','-A','--force')
names=set(git('ls-files','-z').stdout.decode().strip('\0').split('\0'));assert names==set(manifest['files'])|{'APP_UPDATE_MANIFEST.json'}
git('commit','-m','Application update v'+version)
git('tag','app-v'+version)
revision=git('rev-parse','HEAD').stdout.decode().strip()
assert hashlib.sha256(git('show',revision+':APP_UPDATE_MANIFEST.json').stdout).hexdigest()==hashlib.sha256(raw).hexdigest()
git('push','--atomic',remote,'HEAD:refs/heads/app-stable','refs/tags/app-v'+version)
metadata={'gitRevision':revision,'gitRef':'app-v'+version,'gitRuntimeId':manifest['runtimeId'],'gitManifestSha256':hashlib.sha256(raw).hexdigest()}
(work/('app-update-v'+version+'.json')).write_text(json.dumps(metadata,indent=2),encoding='utf-8')
print(json.dumps(metadata))
