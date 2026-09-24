import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


config = module('hosted_inert_config', 'build-config.py')
image = module('hosted_image_context', 'prepare-context.py')


class ImageAndConfigContractTest(unittest.TestCase):
    def test_inert_config_is_exact_deterministic_and_denies_every_tool(self):
        spec = json.loads((HERE / 'inert-config-spec.json').read_text())
        first = config.render(spec)
        second = config.render(dict(reversed(list(spec.items()))))
        self.assertEqual(first, second)
        self.assertEqual(hashlib.sha256(first).hexdigest(),
                         '7de5c79fd8fcb2ba249f1ef0bd18a23e48cf417ef9fd9ecc310c96ce51cc3367')
        self.assertEqual(json.loads(first), {'permission': {'*': 'deny'}, 'plugin': [], 'share': 'disabled'})

    def test_config_rejects_provider_credentials_or_unknown_spec_fields(self):
        for extra in ({'provider': {'local': {}}}, {'apiKey': 'secret'}, {'mode': 'local-model'}):
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(ValueError, 'spec-invalid'):
                    config.render({'schemaVersion': 1, 'mode': 'deny-all-inert', **extra})

    def test_config_parent_walk_rejects_mutable_or_symlinked_ancestor(self):
        with tempfile.TemporaryDirectory(prefix='hosted-config-parent-test-') as root:
            anchor = Path(root)
            mutable = anchor / 'mutable'
            mutable.mkdir(mode=0o700)
            link = anchor / 'link'
            link.symlink_to(mutable, target_is_directory=True)
            anchor_fd = os.open(anchor, config.DIRECTORY_FLAGS)
            try:
                mutable.chmod(0o777)
                with self.assertRaisesRegex(ValueError, 'parent-invalid'):
                    config.descend_trusted(anchor_fd, ['mutable'], os.getuid(), os.getgid())
                with self.assertRaises(OSError):
                    config.descend_trusted(anchor_fd, ['link'], os.getuid(), os.getgid())
            finally:
                os.close(anchor_fd)

    def test_config_dirfd_remains_bound_after_path_swap(self):
        with tempfile.TemporaryDirectory(prefix='hosted-config-swap-test-') as root:
            anchor = Path(root)
            original = anchor / 'original'
            moved = anchor / 'moved'
            bait = anchor / 'bait'
            original.mkdir(mode=0o700)
            bait.mkdir(mode=0o700)
            anchor_fd = os.open(anchor, config.DIRECTORY_FLAGS)
            try:
                parent_fd = config.descend_trusted(anchor_fd, ['original'], os.getuid(), os.getgid())
                try:
                    original.rename(moved)
                    original.symlink_to(bait, target_is_directory=True)
                    os.mkdir('config', mode=0o700, dir_fd=parent_fd)
                    self.assertTrue((moved / 'config').is_dir())
                    self.assertFalse((bait / 'config').exists())
                finally:
                    os.close(parent_fd)
            finally:
                os.close(anchor_fd)

    def test_image_context_is_inactive_until_bootstrap_sha_is_reviewed(self):
        with tempfile.TemporaryDirectory(prefix='hosted-image-recipe-test-') as root:
            archive = Path(root, 'archive')
            bootstrap = Path(root, 'bootstrap')
            output = Path(root, 'context')
            archive.write_bytes(b'not-an-official-archive')
            bootstrap.write_bytes(b'not-a-reviewed-bootstrap')
            with self.assertRaisesRegex(ValueError, 'lock-not-reviewed'):
                image.prepare(str(archive), str(bootstrap), str(output))
            self.assertFalse(output.exists())

    def test_image_lock_rejects_archive_or_base_drift(self):
        lock = json.loads((HERE / 'artifact-lock.json').read_text())
        lock['status'] = 'reviewed'
        lock['bootstrapSha256'] = 'a' * 64
        with tempfile.TemporaryDirectory(prefix='hosted-image-lock-test-') as root:
            path = Path(root, 'lock.json')
            for field, value in [('archiveSha256', 'b' * 64),
                                 ('baseImage', 'ubuntu:latest'),
                                 ('sourceCommit', 'c' * 40)]:
                with self.subTest(field=field):
                    changed = {**lock, field: value}
                    path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, 'lock-not-reviewed'):
                        image.approved_lock(path)


if __name__ == '__main__':
    unittest.main()
