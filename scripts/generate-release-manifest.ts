import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type AssetDescriptor = {
  platform: string;
  file: string;
  archiveKind: 'tar.gz' | 'zip';
  binaryName: string;
  authorityName: string;
  launcherName: string;
};

const releaseDir = path.join(process.cwd(), 'release-flat');
const runtimeVersion = process.env.RUNTIME_VERSION;
const targetReleaseTag = process.env.TARGET_RELEASE_TAG;

if (!runtimeVersion) {
  throw new Error('RUNTIME_VERSION is required');
}

if (!targetReleaseTag) {
  throw new Error('TARGET_RELEASE_TAG is required');
}

const manifestFile = `agent-teams-runtime-manifest-v${runtimeVersion}.json`;
const checksumsFile = `agent-teams-runtime-SHA256SUMS-v${runtimeVersion}`;

const assets: AssetDescriptor[] = [
  {
    platform: 'darwin-arm64',
    file: `agent-teams-runtime-darwin-arm64-v${runtimeVersion}.tar.gz`,
    archiveKind: 'tar.gz',
    binaryName: 'claude-multimodel',
    authorityName: 'opencode-catalog-authority', launcherName: 'opencode-catalog-launcher',
  },
  {
    platform: 'darwin-x64',
    file: `agent-teams-runtime-darwin-x64-v${runtimeVersion}.tar.gz`,
    archiveKind: 'tar.gz',
    binaryName: 'claude-multimodel',
    authorityName: 'opencode-catalog-authority', launcherName: 'opencode-catalog-launcher',
  },
  {
    platform: 'linux-x64',
    file: `agent-teams-runtime-linux-x64-v${runtimeVersion}.tar.gz`,
    archiveKind: 'tar.gz',
    binaryName: 'claude-multimodel',
    authorityName: 'opencode-catalog-authority', launcherName: 'opencode-catalog-launcher',
  },
  {
    platform: 'win32-arm64',
    file: `agent-teams-runtime-win32-arm64-v${runtimeVersion}.zip`,
    archiveKind: 'zip',
    binaryName: 'claude-multimodel.exe',
    authorityName: 'opencode-catalog-authority.exe', launcherName: 'opencode-catalog-launcher.exe',
  },
  {
    platform: 'win32-x64',
    file: `agent-teams-runtime-win32-x64-v${runtimeVersion}.zip`,
    archiveKind: 'zip',
    binaryName: 'claude-multimodel.exe',
    authorityName: 'opencode-catalog-authority.exe', launcherName: 'opencode-catalog-launcher.exe',
  },
];

const manifest = {
  version: runtimeVersion,
  targetReleaseTag,
  generatedAt: new Date().toISOString(),
  sourceRepository: process.env.GITHUB_REPOSITORY,
  sourceRef: process.env.RUNTIME_SOURCE_REF ?? process.env.GITHUB_REF_NAME,
  sourceCommit: process.env.RUNTIME_SOURCE_COMMIT ?? process.env.GITHUB_SHA,
  assets: {} as Record<string, {
    file: string; archiveKind: string; binaryName: string; authorityName: string;
    launcherName: string; nativeChecksumsName: string; sha256: string
  }>,
};

let sums = '';
for (const asset of assets) {
  const assetPath = path.join(releaseDir, asset.file);
  const file = readFileSync(assetPath);
  const sha256 = createHash('sha256').update(file).digest('hex');
  manifest.assets[asset.platform] = {
    file: asset.file,
    archiveKind: asset.archiveKind,
    binaryName: asset.binaryName,
    authorityName: asset.authorityName,
    launcherName: asset.launcherName,
    nativeChecksumsName: 'NATIVE_SHA256SUMS',
    sha256,
  };
  sums += `${sha256}  ${asset.file}\n`;
}

writeFileSync(path.join(releaseDir, manifestFile), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(releaseDir, checksumsFile), sums);
