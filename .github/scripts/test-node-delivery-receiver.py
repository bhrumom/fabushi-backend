import importlib.util
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('node-delivery-receiver.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)

def member(name):
    item = tarfile.TarInfo(name)
    item.size = 1
    return item

class ReceiverTests(unittest.TestCase):
    def test_command(self):
        self.assertEqual(receiver.command('deploy ' + 'a' * 40 + ' ' + 'b' * 64), ('a' * 40, 'b' * 64))
        for command in ['bash', 'deploy ../x y', 'deploy ' + 'a' * 40 + ' ' + 'b' * 64 + ';evil']:
            with self.assertRaises(ValueError): receiver.command(command)

    def test_archive(self):
        valid = [member('src/secure-entry.js'), member('package.json')]
        self.assertEqual(receiver.validate_members(valid), 2)
        for name in ['../escape', '/escape', 'data/private.sqlite', 'src/../../escape', 'src\\evil']:
            with self.assertRaises(ValueError): receiver.validate_members([*valid, member(name)])
        with self.assertRaises(ValueError): receiver.validate_members([*valid, member('package.json')])

    def test_symlink_and_expansion(self):
        valid = [member('src/secure-entry.js'), member('package.json')]
        link = member('node_modules/.bin/tool')
        link.type = tarfile.SYMTYPE
        link.size = 0
        link.linkname = '../tool/bin/tool.js'
        receiver.validate_members([*valid, link])
        link.linkname = '../../../../etc/passwd'
        with self.assertRaises(ValueError): receiver.validate_members([*valid, link])
        huge = member('src/huge')
        huge.size = receiver.MAX_EXPANDED + 1
        with self.assertRaises(ValueError): receiver.validate_members([*valid, huge])

    def test_identity_and_secret_output(self):
        values = dict(zip(receiver.NAMES, ['fixture-private', 'VbvgbVxNAeftFYB0l1-NzE2-Gx3d4NQ7hkKiQ0HMpu0',
                                         'fabushi-marketplace-managed-20261013-1', '1', 'x' * 43]))
        self.assertIn(b'FABUSHI_MARKETPLACE_SIGNING_KEY_ID=', receiver.configuration(values))
        values[receiver.NAMES[1]] = 'unreviewed'
        with self.assertRaises(ValueError): receiver.configuration(values)
        source = Path(__file__).with_name('node-delivery-receiver.py').read_text()
        self.assertNotIn('print(values)', source)
        self.assertNotIn('print(config)', source)
        self.assertNotIn('print(str(error))', source)

if __name__ == '__main__': unittest.main()
