from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import importlib.util
import json

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).resolve().parents[1] / 'scripts/verify_document_backup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with TemporaryDirectory() as temp:
    root = Path(temp)
    name = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222'
    file = root / 'files' / name
    file.parent.mkdir(parents=True)
    data = b'%PDF-1.7\nSynthetic restore verification fixture\n%%EOF'
    file.write_bytes(data)
    item = {'storage_path': name, 'byte_size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    (root/'manifest.json').write_text(json.dumps({'documents': [item]}))
    assert module.verify(root) == 1
    file.write_bytes(data.replace(b'Synthetic', b'Corrupted'))
    try:
        module.verify(root)
        raise AssertionError('Corruption was accepted')
    except ValueError:
        pass
    item['storage_path'] = '../../outside'
    (root/'manifest.json').write_text(json.dumps({'documents': [item]}))
    try:
        module.verify(root)
        raise AssertionError('Path traversal was accepted')
    except ValueError:
        pass
print('PASS: document backup manifest verification, corrupt file rejection and path traversal rejection; synthetic fixtures only.')
