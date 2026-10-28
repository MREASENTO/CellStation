from pathlib import Path
import json,re,sys
root=Path(__file__).resolve().parent.parent;src=root/'workspace';version=sys.argv[1]
assert re.fullmatch(r'\d+\.\d+\.\d+',version)
old=json.loads((src/'package.json').read_text())['version']
assert tuple(map(int,version.split('.')))>tuple(map(int,old.split('.'))),'Version must increase'
for name in ['build-desktop.py','build-desktop.cjs','package-desktop.py','app-updater.cjs','manager-server.cjs','manager-ui/index.html','startup.html','使用说明.txt']:
    p=src/name;p.write_text(p.read_text(encoding='utf-8-sig').replace(old,version),encoding='utf-8')
for name in ['package.json','package-lock.json']:
    p=src/name;data=json.loads(p.read_text(encoding='utf-8-sig'));data['version']=version
    if name=='package-lock.json':data['packages']['']['version']=version
    p.write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
p=root/'README.md';p.write_text(p.read_text(encoding='utf-8').replace(old,version),encoding='utf-8')
print('VERSION',version)
