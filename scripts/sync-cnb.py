"""Sync public release refs; credentials are read only by Git's askpass process."""
from pathlib import Path
import os,sys,subprocess,json
root=Path(__file__).resolve().parent.parent;version=json.loads((root/'workspace/package.json').read_text())['version']
assert os.environ.get('CNB_SYNC_TOKEN'),'CNB_SYNC_TOKEN is required'
temp=root/'work/temp';temp.mkdir(parents=True,exist_ok=True)
script=temp/'cnb-askpass.py';script.write_text("import os,sys\nprint('cnb' if 'username' in sys.argv[1].lower() else os.environ['CNB_SYNC_TOKEN'],end='')\n",encoding='utf-8')
wrapper=temp/('cnb-askpass.cmd' if os.name=='nt' else 'cnb-askpass.sh')
wrapper.write_text(('@echo off\n"'+sys.executable+'" "'+str(script)+'" "%~1"\n') if os.name=='nt' else ('#!/bin/sh\nexec "'+sys.executable+'" "'+str(script)+'" "$1"\n'),encoding='utf-8')
wrapper.chmod(0o700)
env={**os.environ,'GIT_ASKPASS':str(wrapper),'GIT_TERMINAL_PROMPT':'0','GCM_INTERACTIVE':'Never'}
def git(directory,*args,cnb=True):
    options=['-c','safe.directory='+directory.as_posix()]
    if cnb:options+=['-c','credential.helper=']
    subprocess.run(['git',*options,'-C',str(directory),*args],check=True,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
remote='https://cnb.cool/mreasento/CellStation'
git(root,'fetch','--no-tags','origin','refs/tags/v'+version+':refs/tags/v'+version,cnb=False)
git(root,'push',remote,'HEAD:refs/heads/main','refs/tags/v'+version)
app=root/'work/app-publish/CellStation';git(app,'push',remote,'HEAD:refs/heads/app-stable','refs/tags/app-v'+version)
print('CNB_PUBLIC_RELEASE_REFS_SYNCED')
