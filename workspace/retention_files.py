"""Maintain only generated screenshots and closed file logs within one app data root."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import re
import sys
import time
import zipfile

DAY = 86400


def safe(root, file):
    root = Path(root).resolve()
    file = Path(file).absolute()
    if not file.resolve().is_relative_to(root):
        raise ValueError('Path outside application data root')
    for parent in (file, *file.parents):
        if parent == root:
            break
        if parent.exists():
            info = parent.lstat()
            if parent.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Reparse points are not managed')
    return file


def allowed(relative):
    value = Path(relative).as_posix()
    return bool(re.fullmatch(r'outputs/diagnostics/failure-\d+-[a-f0-9]{8}/screenshot\.png', value)
                or re.fullmatch(r'outputs/预约成功_[^/]+\.png', value)
                or re.fullmatch(r'work/captcha_auto_[^/]+\.png', value)
                or re.fullmatch(r'logs/(?:desktop(?:-\d{4}-\d{2}-\d{2})?\.log|startup\.log)', value)
                or value == 'work/startup.log')


def archive_for(root, relative):
    if not allowed(relative):
        raise ValueError('Not an application-managed screenshot or log')
    return safe(root, Path(root) / 'archives' / (Path(relative).as_posix() + '.zip'))


def archive_manifest(root, relative):
    with zipfile.ZipFile(archive_for(root, relative)) as source:
        meta = json.loads(source.read('manifest.json'))
        member = meta.get('member', 'content')
        if member not in ('content', Path(relative).name) or meta.get('source') != Path(relative).as_posix() or set(source.namelist()) != {'manifest.json', member}:
            raise ValueError('Archive metadata mismatch')
        return meta


def archive_data(root, relative):
    meta = archive_manifest(root, relative)
    with zipfile.ZipFile(archive_for(root, relative)) as source:
        data = source.read(meta.get('member', 'content'))
        if hashlib.sha256(data).hexdigest() != meta.get('sha256') or len(data) != meta.get('size'):
            raise ValueError('Archive content checksum mismatch')
        return meta, data


def read_managed(root, relative):
    if not allowed(relative):
        raise ValueError('Unsupported managed file')
    file = safe(root, Path(root) / relative)
    if file.is_file():
        return file.read_bytes()
    return archive_data(root, relative)[1]


def diagnostic_note(root, relative, expired):
    if not Path(relative).as_posix().startswith('outputs/diagnostics/'):
        return
    file = safe(root, Path(root) / relative).with_name('report.json')
    if not file.is_file():
        return
    file = safe(root, file)
    report = json.loads(file.read_text(encoding='utf-8'))
    report['screenshotArchived'] = not expired
    if expired:
        report['screenshot'] = False
        report['screenshotExpired'] = True
        report['screenshotError'] = '截图已按文件保留规则清理，预约结果和诊断原因仍保留。'
    temporary = file.with_name(file.name + '.retention.tmp')
    safe(root, temporary).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, file)


def original_time(root, relative):
    file = safe(root, Path(root) / relative)
    modified = file.stat().st_mtime
    value = Path(relative).as_posix()
    if value.startswith('outputs/diagnostics/'):
        try:
            report = json.loads(safe(root, file.with_name('report.json')).read_text(encoding='utf-8'))
            if report.get('screenshotAt'):
                return float(report['screenshotAt']) / 1000
            return datetime.fromisoformat(report['at'].replace('Z', '+00:00')).timestamp()
        except (ValueError, KeyError, OSError, TypeError):
            pass
    match = re.search(r'_(\d{13})\.png$', file.name)
    if value.startswith('outputs/预约成功_') and match:
        return int(match.group(1)) / 1000
    if value.startswith('work/captcha_auto_'):
        try:
            stamp = file.name[len('captcha_auto_'):].rsplit('_', 1)[0]
            return datetime.strptime(stamp, '%Y-%m-%dT%H-%M-%S-%fZ').replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            pass
    match = re.fullmatch(r'desktop-(\d{4}-\d{2}-\d{2})\.log', file.name)
    if value.startswith('logs/') and match:
        beginning = datetime.strptime(match.group(1), '%Y-%m-%d').replace(tzinfo=timezone(timedelta(hours=8))).timestamp()
        return modified if beginning <= modified < beginning + DAY else beginning + DAY - 1
    return modified


def compress(root, relative, now):
    file = safe(root, Path(root) / relative)
    before = file.stat()
    data = file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    destination = archive_for(root, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    safe(root, destination)
    if destination.exists():
        meta, archived = archive_data(root, relative)
        if float(meta['originalMtime']) != original_time(root, relative):
            raise ValueError('Source date changed; original retained')
        if archived != data:
            raise ValueError('Different archive already exists; original retained')
    else:
        temporary = safe(root, destination.with_name(destination.name + f'.{os.getpid()}.tmp'))
        meta = {'version': 1, 'source': Path(relative).as_posix(), 'originalMtime': original_time(root, relative),
                'archivedAt': now, 'sha256': digest, 'size': len(data), 'member': file.name}
        try:
            with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('manifest.json', json.dumps(meta))
                archive.writestr(file.name, data)
            with zipfile.ZipFile(temporary) as check:
                if check.testzip() is not None:
                    raise ValueError('ZIP CRC verification failed')
            os.replace(temporary, destination)
            archive_data(root, relative)
        finally:
            if temporary.exists():
                safe(root, temporary).unlink()
    after = safe(root, file).stat()
    if before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
        raise ValueError('File changed during compression; original retained')
    diagnostic_note(root, relative, False)
    safe(root, file).unlink()


def candidates(root):
    for base in ('outputs', 'work', 'logs', 'outputs/diagnostics'):
        directory = root / base
        if not directory.exists():
            continue
        safe(root, directory)
        patterns = {'outputs': ['预约成功_*.png'], 'work': ['captcha_auto_*.png', 'startup.log'],
                    'logs': ['desktop*.log', 'startup.log'], 'outputs/diagnostics': ['failure-*']}[base]
        for pattern in patterns:
            for item in directory.glob(pattern):
                if base == 'outputs/diagnostics':
                    safe(root, item)
                    item = item / 'screenshot.png'
                    if not item.exists():
                        continue
                relative = item.relative_to(root).as_posix()
                if allowed(relative):
                    yield relative


def archive_candidates(root):
    archives = root / 'archives'
    if not archives.exists():
        return
    safe(root, archives)
    for parent, directories, files in os.walk(archives, followlinks=False):
        safe(root, parent)
        for name in list(directories):
            try:
                safe(root, Path(parent) / name)
            except ValueError:
                directories.remove(name)
        for name in files:
            if name.endswith('.zip'):
                yield Path(parent) / name


def maintain(root, policy, now, limit=20):
    root = Path(root).resolve()
    compress_days, delete_days = policy['compressAfterDays'], policy['deleteAfterDays']
    if not isinstance(compress_days, int) or not isinstance(delete_days, int) or not 1 <= compress_days < delete_days <= 3650:
        raise ValueError('Invalid retention days')
    result = {'compressed': 0, 'deleted': 0, 'skipped': 0, 'errors': [], 'more': False}
    processed = 0
    today = time.strftime('%Y-%m-%d', time.gmtime(now + 8 * 3600))
    for relative in sorted(set(candidates(root))):
        try:
            file = safe(root, root / relative)
            if relative == f'logs/desktop-{today}.log':
                continue
            age = (now - original_time(root, relative)) / DAY
            if age < compress_days:
                continue
            if processed >= limit:
                result['more'] = True
                break
            processed += 1
            if age >= delete_days:
                archive = archive_for(root, relative)
                if archive.exists():
                    archive_data(root, relative)
                safe(root, file).unlink()
                if archive.exists():
                    safe(root, archive).unlink()
                diagnostic_note(root, relative, True)
                result['deleted'] += 1
            else:
                compress(root, relative, now)
                result['compressed'] += 1
        except Exception as error:
            result['errors'].append({'file': relative, 'error': str(error)[:200]})
    archives = root / 'archives'
    if archives.exists():
        safe(root, archives)
        for archive in sorted(archive_candidates(root)):
            try:
                archive = safe(root, archive)
                relative = archive.relative_to(archives).as_posix()[:-4]
                if not allowed(relative):
                    continue
                meta = archive_manifest(root, relative)
                if (now - float(meta['originalMtime'])) / DAY < delete_days:
                    continue
                if processed >= limit:
                    result['more'] = True
                    break
                processed += 1
                safe(root, archive).unlink()
                diagnostic_note(root, relative, True)
                result['deleted'] += 1
            except Exception as error:
                result['errors'].append({'file': str(archive), 'error': str(error)[:200]})
    return result


if __name__ == '__main__':
    operation, root, argument = sys.argv[1:4]
    if operation == 'read':
        sys.stdout.buffer.write(read_managed(root, argument))
    elif operation == 'maintain':
        print(json.dumps(maintain(root, json.loads(argument), float(sys.argv[4]), int(sys.argv[5]))))
    else:
        raise ValueError('Unsupported operation')
