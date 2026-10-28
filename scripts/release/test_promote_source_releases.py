import importlib.util
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promotion', __file__.replace('test_promote_source_releases.py', 'promote-source-releases.py'))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


class PromotionTest(unittest.TestCase):
    def setUp(self):
        self.tag = 'v0.0.145'
        self.sha = 'a' * 40
        self.digest = 'b' * 64
        self.assets = {
            platform: {'file': f'agent-teams-runtime-{platform}-{self.tag}.{extension}', 'sha256': self.digest}
            for platform, extension in [('darwin-arm64', 'tar.gz'), ('darwin-x64', 'tar.gz'),
                                        ('linux-x64', 'tar.gz'), ('win32-x64', 'zip')]
        }
        self.manifest = dict(version='0.0.145', sourceRepository=promotion.SOURCE,
                             sourceRef=self.tag, sourceCommit=self.sha, assets=self.assets)
        self.release = dict(draft=False, prerelease=False, tag_name='runtime-' + self.tag,
                            assets=[{'name': a['file'], 'size': 100} for a in self.assets.values()] + [
                                {'name': f'agent-teams-runtime-manifest-{self.tag}.json', 'size': 100},
                                {'name': f'agent-teams-runtime-SHA256SUMS-{self.tag}', 'size': 100}])
        self.calls = []
        self.published = False

    def public(self, url):
        if url.endswith('/releases/tags/' + self.tag):
            return dict(draft=False, prerelease=False)
        return self.manifest if url.endswith('.json') else self.release

    def gh(self, path):
        if promotion.BINARIES in path:
            return self.release
        return {'sha': self.sha} if '/commits/' in path else dict(id=42, tag_name=self.tag, draft=not self.published, prerelease=False)

    def command(self, *args):
        self.calls.append(args)
        if 'PATCH' in args:
            self.published = True
        if args[0] == 'curl' and '--head' not in args:
            return '\n'.join(f'{self.digest}  {a["file"]}' for a in self.assets.values())
        return ''

    def run_promotion(self, apply=True):
        with patch.object(promotion, 'public_json', side_effect=self.public), \
             patch.object(promotion, 'gh_json', side_effect=self.gh), \
             patch.object(promotion, 'command', side_effect=self.command):
            return promotion.promote(self.tag, apply, 42)

    def test_verified_delivery_publishes_after_anonymous_asset_checks(self):
        self.assertEqual(self.run_promotion()['status'], 'published')
        patch_index = next(i for i, c in enumerate(self.calls) if 'PATCH' in c)
        self.assertEqual(sum('--head' in c for c in self.calls[:patch_index]), 6)
        self.assertIn('make_latest=false', self.calls[patch_index])

    def test_dry_run_never_publishes(self):
        self.assertEqual(self.run_promotion(False)['status'], 'ready')
        self.assertFalse(any('PATCH' in c for c in self.calls))

    def test_unqualified_deliveries_never_publish(self):
        for defect in ['draft', 'prerelease', 'wrong-commit', 'missing-platform', 'missing-upload', 'bad-checksum']:
            with self.subTest(defect=defect):
                self.setUp()
                if defect in ['draft', 'prerelease']:
                    self.release[defect] = True
                elif defect == 'wrong-commit':
                    self.manifest['sourceCommit'] = 'c' * 40
                elif defect == 'missing-platform':
                    del self.assets['linux-x64']
                elif defect == 'missing-upload':
                    self.release['assets'].pop()
                else:
                    self.assets['linux-x64']['sha256'] = 'd' * 64
                with self.assertRaises(ValueError):
                    self.run_promotion()
                self.assertFalse(any('PATCH' in c for c in self.calls))

    def test_existing_public_source_is_unchanged(self):
        original = self.gh
        self.gh = lambda path: original(path) if '/commits/' in path or promotion.BINARIES in path else dict(tag_name=self.tag, draft=False)
        self.assertEqual(self.run_promotion()['status'], 'already-public')
        self.assertFalse(any('PATCH' in c for c in self.calls))

    def test_unavailable_anonymous_asset_prevents_publication(self):
        original = self.command
        def fail_head(*args):
            if '--head' in args:
                raise promotion.subprocess.CalledProcessError(22, args)
            return original(*args)
        self.command = fail_head
        with self.assertRaises(promotion.subprocess.CalledProcessError):
            self.run_promotion()
        self.assertFalse(any('PATCH' in c for c in self.calls))


if __name__ == '__main__':
    unittest.main()
