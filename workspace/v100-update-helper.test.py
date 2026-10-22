from pathlib import Path
import unittest, tempfile, zipfile, json, hashlib, importlib.util
from unittest.mock import patch
root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('helper',root/'workspace/update-helper.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
class UpdateTransactions(unittest.TestCase):
    def fixture(self):
        install=Path(tempfile.mkdtemp(prefix='v100-update-',dir=root/'work/tests'));data=install/'data';data.mkdir();(data/'keep.txt').write_text('user data')
        (install/'CellStation.exe').write_bytes(b'old executable');(install/'resources').mkdir();(install/'resources/old.txt').write_text('old')
        tx=data/'updates/tx-test';tx.mkdir(parents=True);archive=tx/'package.zip'
        with zipfile.ZipFile(archive,'w') as z:
            z.writestr('CellStation-win32-x64/CellStation.exe',b'new executable');z.writestr('CellStation-win32-x64/resources/app/package.json',json.dumps({'version':'1.0.1'}));z.writestr('CellStation-win32-x64/PACKAGE_MANIFEST.json',json.dumps({'version':'1.0.1','accountDataIncluded':False}))
        params={'install':str(install),'data':str(data),'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'version':'1.0.1','nonce':'mock-nonce','pid':1}
        file=tx/'transaction.json';file.write_text(json.dumps(params));return install,data,tx,archive,file
    def test_success_preserves_data_and_removes_old_program_backup(self):
        install,data,tx,archive,file=self.fixture()
        class Child:
            def poll(self):return None
        def spawn(*args,**kwargs):
            (data/'updates/health.json').write_text(json.dumps({'nonce':'mock-nonce','version':'1.0.1'}));return Child()
        with patch.object(helper,'wait_exit'),patch.object(helper.subprocess,'Popen',side_effect=spawn):helper.apply_update(file)
        self.assertEqual((install/'CellStation.exe').read_bytes(),b'new executable');self.assertEqual((data/'keep.txt').read_text(),'user data');self.assertFalse((tx/'rollback').exists());self.assertFalse(archive.exists())
    def test_failed_startup_restores_old_program_and_preserves_data(self):
        install,data,tx,archive,file=self.fixture();calls=[]
        class Child:
            def poll(self):return 1
        def spawn(*args,**kwargs):calls.append(args[0]);return Child()
        with patch.object(helper,'wait_exit'),patch.object(helper.subprocess,'Popen',side_effect=spawn):
            with self.assertRaises(RuntimeError):helper.apply_update(file)
        self.assertEqual((install/'CellStation.exe').read_bytes(),b'old executable');self.assertEqual((install/'resources/old.txt').read_text(),'old');self.assertEqual((data/'keep.txt').read_text(),'user data');self.assertEqual(calls[-1][-1],'--skip-update-once')
    def test_traversal_and_data_in_archive_are_rejected_before_application_exit(self):
        for filename in ['../outside.txt','CellStation-win32-x64/data/private.txt','CellStation-win32-x64/resources/../../outside.txt']:
            install,data,tx,archive,file=self.fixture()
            with zipfile.ZipFile(archive,'a') as z:z.writestr(filename,'bad')
            with self.assertRaises(ValueError):helper.validate_archive(archive,'1.0.1')
            self.assertEqual((install/'CellStation.exe').read_bytes(),b'old executable')
if __name__=='__main__':unittest.main()
