from pathlib import Path
import urllib.request,zipfile,hashlib,subprocess,sys,json
root=Path(__file__).resolve().parent.parent;work=root/'work';work.mkdir(exist_ok=True);(work/'tests').mkdir(exist_ok=True)
temp=work/'temp';temp.mkdir(exist_ok=True)
import os
os.environ['TEMP']=os.environ['TMP']=str(temp)
def fetch(url,target):
    if not target.exists():
        with urllib.request.urlopen(url,timeout=120) as response,target.open('wb') as output:
            while block:=response.read(1024*1024):output.write(block)
python_zip=work/'python-3.13.12-embed-amd64.zip'
fetch('https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip',python_zip)
assert hashlib.sha256(python_zip.read_bytes()).hexdigest()=='76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0'
with zipfile.ZipFile(python_zip) as archive:archive.extractall(work/'python-embedded')
venv=root/'workspace/.venv';subprocess.run([sys.executable,'-m','venv',str(venv)],check=True)
subprocess.run([str(venv/'Scripts/python.exe'),'-m','pip','install','-r',str(root/'workspace/requirements-ocr.txt')],check=True)
electron=work/'electron-download';electron.mkdir(exist_ok=True)
name='electron-v45.0.0-win32-x64.zip';fetch('https://github.com/electron/electron/releases/download/v45.0.0/'+name,electron/name)
checks=electron/'SHASUMS256.txt';fetch('https://github.com/electron/electron/releases/download/v45.0.0/SHASUMS256.txt',checks)
expected=next(line.split()[0] for line in checks.read_text().splitlines() if line.split()[-1].lstrip('*')==name)
with (electron/name).open('rb') as source:assert hashlib.file_digest(source,'sha256').hexdigest()==expected
print('BUILD_DEPENDENCIES_READY')
