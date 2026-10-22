from pathlib import Path
import json,hashlib,sys
root=Path(__file__).resolve().parent.parent;version=json.loads((root/'workspace/package.json').read_text())['version']
metadata=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
assert metadata['tag_name']=='v'+version and not metadata['draft'] and not metadata['prerelease']
name='CellStation-v'+version+'-win64.zip';file=root/'outputs'/name
asset=next(a for a in metadata['assets'] if a['name']==name)
with file.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
assert asset['state']=='uploaded' and asset['size']==file.stat().st_size and asset['digest']=='sha256:'+digest
assert all(a['name'] in [name,name.replace('.zip','.sha256.txt'),'CellStation-v'+version+'-README.txt'] for a in metadata['assets'])
print('RELEASE_ASSETS_VERIFIED_BEFORE_UPDATE_FEED')
