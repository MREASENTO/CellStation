from pathlib import Path
import unittest,tempfile
from app_package import runtime_id
root=Path(__file__).resolve().parent.parent
class Compatibility(unittest.TestCase):
    def test_application_versions_and_machine_specific_records_do_not_force_runtime_update(self):
        p=Path(tempfile.mkdtemp(prefix='v102-runtime-',dir=root/'work/tests'))
        for name,content in {'CellStation.exe':'launcher metadata 1.0.2','version':'45.0.0','resources/app/package.json':'1.0.2','resources/app/runtime/python/python313.dll':'same engine','resources/app/runtime/python/Lib/site-packages/mock.dist-info/RECORD':'local script hashes'}.items():
            f=p/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(content)
        before=runtime_id(p);(p/'CellStation.exe').write_text('launcher metadata 1.0.3');(p/'resources/app/package.json').write_text('1.0.3');(p/'resources/app/runtime/python/Lib/site-packages/mock.dist-info/RECORD').write_text('other machine paths')
        self.assertEqual(runtime_id(p),before)
        (p/'resources/app/runtime/python/python313.dll').write_text('updated engine');self.assertNotEqual(runtime_id(p),before)
    def test_electron_engine_version_change_requires_full_runtime_update(self):
        p=Path(tempfile.mkdtemp(prefix='v102-runtime-',dir=root/'work/tests'));(p/'version').write_text('45.0.0');before=runtime_id(p);(p/'version').write_text('46.0.0');self.assertNotEqual(runtime_id(p),before)
if __name__=='__main__':unittest.main()
