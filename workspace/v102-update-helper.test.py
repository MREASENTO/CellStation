from pathlib import Path
import unittest,tempfile,zipfile,json,hashlib,importlib.util
from unittest.mock import patch
root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('helper',root/'workspace/update-helper.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
def sha(data):return hashlib.sha256(data).hexdigest()
class AppUpdates(unittest.TestCase):
    def fixture(self):
        install=Path(tempfile.mkdtemp(prefix='v102-partial-',dir=root/'work/tests'));data=install/'data';tx=data/'updates/tx-test';tx.mkdir(parents=True)
        runtime='a'*64
        old={'resources/app/package.json':b'{"version":"1.0.2"}','resources/app/obsolete.js':b'old feature','resources/app/stable.js':b'unchanged','PACKAGE_MANIFEST.json':json.dumps({'version':'1.0.2','runtimeId':runtime,'accountDataIncluded':False}).encode()}
        for name,content in {**old,'CellStation.exe':b'keep electron','resources/app/runtime/python/python.exe':b'keep python','resources/app/runtime/git/cmd/git.exe':b'keep git','resources/app/untracked.txt':b'preserve unowned'}.items():
            p=install/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content)
        def manifest(version,files):return {'product':'CellStation','kind':'app','version':version,'runtimeId':runtime,'accountDataIncluded':False,'files':{name:sha(b) for name,b in files.items()}}
        (install/'APP_UPDATE_MANIFEST.json').write_text(json.dumps(manifest('1.0.2',old)),encoding='utf-8')
        new={'resources/app/package.json':b'{"version":"1.0.3"}','resources/app/new.js':b'new feature','resources/app/stable.js':b'unchanged','PACKAGE_MANIFEST.json':json.dumps({'version':'1.0.3','runtimeId':runtime,'accountDataIncluded':False}).encode()}
        raw=(json.dumps(manifest('1.0.3',new))+'\n').encode();archive=tx/'app.zip'
        with zipfile.ZipFile(archive,'w') as z:
            for name,b in {**new,'APP_UPDATE_MANIFEST.json':raw}.items():z.writestr('CellStation-win32-x64/'+name,b)
        account=data/'work/manager/manager-state.json';account.parent.mkdir(parents=True);account.write_text('{"accounts":["mock-encrypted"],"jobs":["existing-result"]}')
        params={'install':str(install),'data':str(data),'archive':str(archive),'sha256':sha(archive.read_bytes()),'version':'1.0.3','nonce':'mock','pid':1,'kind':'app','runtimeId':runtime,'manifestSha256':sha(raw)}
        transaction=tx/'transaction.json';transaction.write_text(json.dumps(params));return install,data,tx,archive,transaction,params
    def test_success_replaces_only_changed_owned_files_and_preserves_runtime_and_data(self):
        install,data,tx,archive,file,p=self.fixture();stable=install/'resources/app/stable.js';stamp=stable.stat().st_mtime_ns
        class Child:
            def poll(self):return None
        def spawn(*a,**kw):(data/'updates/health.json').write_text(json.dumps({'version':'1.0.3','nonce':'mock'}));return Child()
        with patch.object(helper,'wait_exit'),patch.object(helper.subprocess,'Popen',side_effect=spawn):helper.apply_update(file)
        self.assertFalse((install/'resources/app/obsolete.js').exists());self.assertEqual((install/'resources/app/new.js').read_bytes(),b'new feature');self.assertEqual(stable.stat().st_mtime_ns,stamp)
        self.assertEqual((install/'resources/app/runtime/python/python.exe').read_bytes(),b'keep python');self.assertEqual((install/'CellStation.exe').read_bytes(),b'keep electron');self.assertEqual((install/'resources/app/untracked.txt').read_bytes(),b'preserve unowned')
        self.assertIn('existing-result',(data/'work/manager/manager-state.json').read_text());self.assertFalse((tx/'rollback').exists());self.assertFalse(archive.exists())
    def test_failed_app_start_rolls_back_code_deleted_files_and_migrated_settings(self):
        install,data,tx,archive,file,p=self.fixture();account=data/'work/manager/manager-state.json';old=account.read_bytes();calls=[]
        class Child:
            def poll(self):return 1
        def spawn(*a,**kw):
            calls.append(a[0])
            if len(calls)==1:account.write_text('{"changed":true}')
            else:self.assertEqual(account.read_bytes(),old)
            return Child()
        with patch.object(helper,'wait_exit'),patch.object(helper.subprocess,'Popen',side_effect=spawn):
            with self.assertRaises(RuntimeError):helper.apply_update(file)
        self.assertEqual((install/'resources/app/obsolete.js').read_bytes(),b'old feature');self.assertFalse((install/'resources/app/new.js').exists());self.assertEqual(json.loads((install/'resources/app/package.json').read_text())['version'],'1.0.2')
        self.assertEqual((tx/'data-state/work/manager/manager-state.json').read_bytes(),old);self.assertEqual(calls[-1][-1],'--skip-update-once')
        self.assertEqual((install/'resources/app/runtime/git/cmd/git.exe').read_bytes(),b'keep git')
    def test_changed_file_or_signed_manifest_digest_rejects_before_application_exit(self):
        install,data,tx,archive,file,p=self.fixture()
        with self.assertRaises(ValueError):helper.validate_app_archive(archive,'1.0.3',p['runtimeId'],'b'*64)
        with zipfile.ZipFile(archive,'a') as z:z.writestr('CellStation-win32-x64/resources/app/evil.js',b'unlisted')
        with self.assertRaises(ValueError):helper.validate_app_archive(archive,'1.0.3',p['runtimeId'],p['manifestSha256'])
        self.assertEqual((install/'CellStation.exe').read_bytes(),b'keep electron')
    def test_runtime_or_private_data_in_app_archive_is_rejected(self):
        for name in ['data/private.json','resources/app/runtime/python/python.exe','resources/app/../data/secret','resources/app/CON.txt']:
            install,data,tx,archive,file,p=self.fixture()
            with zipfile.ZipFile(archive,'a') as z:z.writestr('CellStation-win32-x64/'+name,b'bad')
            with self.assertRaises(ValueError):helper.validate_app_archive(archive,'1.0.3',p['runtimeId'],p['manifestSha256'])
    def test_incompatible_local_runtime_and_unsafe_old_inventory_are_rejected(self):
        install,data,tx,archive,file,p=self.fixture();old=install/'APP_UPDATE_MANIFEST.json';m=json.loads(old.read_text());m['runtimeId']='b'*64;old.write_text(json.dumps(m))
        with self.assertRaises(ValueError):helper.validate_app_archive(archive,'1.0.3',p['runtimeId'],p['manifestSha256'],install)
        m['runtimeId']=p['runtimeId'];m['files']['data/private.json']='c'*64;old.write_text(json.dumps(m))
        with self.assertRaises(ValueError):helper.validate_app_archive(archive,'1.0.3',p['runtimeId'],p['manifestSha256'],install)
if __name__=='__main__':unittest.main()
