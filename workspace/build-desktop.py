"""Prepare a clean Windows desktop app; never package runtime account data."""
from pathlib import Path
import json, shutil, hashlib
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
source = root / 'workspace'
stage = root / 'work' / 'desktop-stage-v1.0.3'
if stage.exists():
    raise SystemExit('Stage already exists; choose a new stage version instead of overwriting')
stage.mkdir()
files = ['git-updates.cjs','wechat-notifications.cjs','app-updater.cjs','desktop-updates.cjs','update-helper.py','release-config.json','startup.html','startup.js','startup.css','retention.cjs','retention_files.py','equipment.cjs','timeline.cjs','operations.cjs','support-files.cjs','archive-support.py','desktop-integration.cjs','runtime-paths.cjs','manager-server.cjs','manager-store.cjs','schedule-logic.cjs','scheduler.cjs','vault.cjs','browser-worker.cjs','auto-login.cjs','ocr.cjs','recognize-captcha.py','reservation.cjs','booking-logic.cjs','booking-rules.json']
workspace = stage / 'workspace'; workspace.mkdir()
for name in files: shutil.copy2(source / name, workspace / name)
shutil.copytree(source / 'manager-ui', workspace / 'manager-ui')
shutil.copytree(source / 'fixtures', workspace / 'fixtures')
(workspace / 'node_modules').mkdir()
for name in ['playwright','playwright-core']:
    shutil.copytree(source / 'node_modules' / name, workspace / 'node_modules' / name, ignore=shutil.ignore_patterns('__pycache__'))
shutil.copy2(source / 'desktop-main.cjs', stage / 'desktop-main.cjs')
(stage / 'package.json').write_text(json.dumps({'name':'cellstation-desktop','productName':'CellStation','version':'1.0.3','main':'desktop-main.cjs','description':'Local desktop cell station reservation manager','author':'CellStation','private':True},indent=2),encoding='utf-8')
python = stage / 'runtime' / 'python'
shutil.copytree(root / 'work' / 'python-embedded', python)
packages = python / 'Lib' / 'site-packages'; packages.mkdir(parents=True)
original = source / '.venv' / 'Lib' / 'site-packages'
for item in original.iterdir():
    if item.name == 'pip' or item.name.startswith('pip-') or item.name == '__pycache__': continue
    destination = packages / item.name
    if item.is_dir(): shutil.copytree(item,destination,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    else: shutil.copy2(item,destination)
(python/'python313._pth').write_text('python313.zip\n.\nLib/site-packages\nimport site\n',encoding='ascii')
shutil.copytree(root/'work/mingit-runtime',stage/'runtime/git')
assets = stage/'assets'; assets.mkdir()
icon=Image.new('RGBA',(256,256),(0,0,0,0)); d=ImageDraw.Draw(icon)
d.rounded_rectangle((10,10,246,246),radius=55,fill='#286b53')
font=ImageFont.truetype('C:/Windows/Fonts/georgiab.ttf',190)
d.text((51,7),'C',font=font,fill='white')
d.ellipse((177,51,199,73),fill='#d6e7a9')
icon.save(assets/'icon.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
icon.resize((32,32),Image.Resampling.LANCZOS).save(assets/'tray.png')
(stage/'THIRD-PARTY.txt').write_text('Electron: https://www.electronjs.org/ (MIT; Chromium notices supplied by Electron)\nPython 3.13.12: https://www.python.org/downloads/release/python-31312/ (LICENSE.txt in runtime/python)\nPlaywright: https://github.com/microsoft/playwright (Apache-2.0; package LICENSE files included)\nddddocr: https://github.com/sml2h3/ddddocr (MIT; dependency metadata/license files included)\n',encoding='utf-8')
print('DESKTOP_STAGE_READY',stage)
