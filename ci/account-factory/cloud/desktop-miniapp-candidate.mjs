import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync, appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const requiredSteps = ['Build and stage Mahayana desktop host', 'Package signed and notarized macOS installer', 'Notarize and staple DMG', 'Bind packaged candidate executable', 'Run real signed packaged acceptance', 'Run approved Mini App installed and OS-offline lifecycle acceptance'];
export const requiredChecks = ['rust-host', 'renderer', 'platform-worker', 'Pressure profiler / macos-15', 'Pressure profiler / ubuntu-24.04', 'Pressure profiler / windows-2025', 'Focused Electron chat E2E', 'Renderer typecheck and build', 'bounded-validation', 'native-intents', 'publisher', 'electron-window', 'verifier'];
const fail = (code) => { throw Error(code); };

export function validateCandidate({ sourceSha, artifactId, archiveSha, run, artifact, jobs, checks, version }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || !/^[a-f0-9]{64}$/.test(archiveSha || '') || !/^[1-9][0-9]*$/.test(String(artifactId || '')) || !Number.isSafeInteger(Number(artifactId))) fail('DFC_INPUT_INVALID');
  if (run.head_sha !== sourceSha || run.head_branch !== 'main' || run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'success' || run.path !== '.github/workflows/release-macos-main.yml' || run.repository?.full_name !== 'bhrumom/fabushi-desktop' || run.head_repository?.full_name !== 'bhrumom/fabushi-desktop') fail('DFC_SOURCE_RUN_DENIED');
  if (artifact.id !== Number(artifactId) || artifact.expired !== false || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== sourceSha || artifact.digest !== `sha256:${archiveSha}` || artifact.name !== `fabushi-macos-${sourceSha.slice(0, 12)}` || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 1024 ** 3) fail('DFC_ARTIFACT_DENIED');
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version || '')) fail('DFC_VERSION_DENIED');
  const passed = new Set(jobs.flatMap((job) => job.steps || []).filter((step) => step.conclusion === 'success').map((step) => step.name));
  if (!requiredSteps.every((name) => passed.has(name))) fail('DFC_PACKAGED_GATE_MISSING');
  if (!requiredChecks.every((name) => { const found = checks.filter((item) => item.name === name); return found.length > 0 && found.every((item) => item.status === 'completed' && item.conclusion === 'success'); })) fail('DFC_SOURCE_CI_MISSING');
  return { desktopSourceSha: sourceSha, artifactId: Number(artifactId), archiveSha256: archiveSha, candidateRunId: run.id, version, sourceCiVerified: true, productionPackagedGatesVerified: true };
}

export async function prepareCandidate() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' || process.platform !== 'darwin' || process.arch !== 'arm64') fail('DFC_RUNNER_DENIED');
  const sourceSha = process.env.DESKTOP_SOURCE_SHA;
  const artifactId = process.env.DESKTOP_ARTIFACT_ID;
  const archiveSha = process.env.DESKTOP_ARCHIVE_SHA256;
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || !/^[1-9][0-9]*$/.test(artifactId || '') || !/^[a-f0-9]{64}$/.test(archiveSha || '')) fail('DFC_INPUT_INVALID');
  if (execFileSync('git', ['-C', 'desktop-source', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceSha) fail('DFC_HARNESS_SOURCE_INVALID');
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/bhrumom/fabushi-desktop/${path}`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'Fabushi-Isolated-Desktop-Acceptance/1' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail('DFC_GITHUB_READ_FAILED');
    return response.json();
  };
  const artifact = await api(`actions/artifacts/${artifactId}`);
  const run = await api(`actions/runs/${artifact.workflow_run?.id}`);
  const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`);
  const { check_runs: checks } = await api(`commits/${sourceSha}/check-runs?per_page=100`);
  const pkg = await api(`contents/desktop/package.json?ref=${sourceSha}`);
  const version = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
  const report = validateCandidate({ sourceSha, artifactId, archiveSha, artifact, run, jobs, checks, version });
  const root = join(process.env.RUNNER_TEMP, 'miniapp-factory-candidate');
  mkdirSync(root, { mode: 0o700 });
  const archivePath = join(root, 'candidate.zip');
  const fd = openSync(archivePath, 'wx', 0o600);
  try { execFileSync('gh', ['api', `repos/bhrumom/fabushi-desktop/actions/artifacts/${artifactId}/zip`], { stdio: ['ignore', fd, 'pipe'], timeout: 180_000 }); }
  finally { closeSync(fd); }
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(archivePath)) { bytes += chunk.length; hash.update(chunk); }
  if (bytes !== artifact.size_in_bytes || hash.digest('hex') !== archiveSha) fail('DFC_ARCHIVE_INTEGRITY');
  const delivery = join(root, 'delivery'); const application = join(root, 'application');
  mkdirSync(delivery); mkdirSync(application);
  const installer = `fabushi-${version}-macos-arm64.zip`;
  execFileSync('/usr/bin/unzip', ['-q', archivePath, installer, '-d', delivery], { stdio: 'pipe' });
  execFileSync('/usr/bin/ditto', ['-xk', join(delivery, installer), application], { stdio: 'pipe' });
  const apps = readdirSync(application).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) fail('DFC_APPLICATION_AMBIGUOUS');
  const installed = `/Applications/Fabushi Factory ${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.app`;
  execFileSync('/usr/bin/ditto', [join(application, apps[0]), installed], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], { stdio: 'pipe' });
  execFileSync(process.execPath, [resolve('desktop-source/.github/scripts/validate-apple-ticket.mjs'), installed], { stdio: 'inherit' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', installed], { stdio: 'pipe' });
  const plist = join(installed, 'Contents/Info.plist');
  const bundleVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim();
  const binary = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' }).trim();
  if (bundleVersion !== version || !/^[A-Za-z0-9._-]+$/.test(binary)) fail('DFC_APPLICATION_IDENTITY');
  mkdirSync('desktop-evidence', { recursive: true });
  writeFileSync('desktop-evidence/candidate.json', JSON.stringify(report, null, 2));
  appendFileSync(process.env.GITHUB_ENV, `FABUSHI_ELECTRON_EXECUTABLE=${installed}/Contents/MacOS/${binary}\nOBF_SOURCE_SHA=${sourceSha}\nOBF_EXPECTED_SOURCE_SHA=${sourceSha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await prepareCandidate(); }
  catch (error) { console.error(/^DFC_[A-Z_]+$/.test(error.message || '') ? error.message : 'DFC_CANDIDATE_FAILED'); process.exitCode = 1; }
}
