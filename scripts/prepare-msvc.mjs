/** App-local Microsoft CRT from an unmodified, hash-pinned official redist.
 * Extract only; never run an installer or require administrator access. */
import { mkdir, readFile, writeFile, copyFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const url = 'https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b';

export async function prepareMsvc(pythonDirectory, cacheRoot) {
  if (process.platform !== 'win32') throw new Error('The desktop Microsoft CRT assembly step requires Windows.');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const requirement = 'A licensed Visual Studio installation with C++ tools is required to redistribute its CRT. See docs/desktop.md.';
  try {
    const visualStudio = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
    if (!visualStudio) throw new Error(requirement);
  } catch (error) { throw new Error(requirement, { cause: error }); }
  const cache = path.join(cacheRoot, 'msvc-14.44.35211');
  await mkdir(cache, { recursive: true });
  const executable = path.join(cache, 'VC_redist.x64.exe');
  let bytes = await readFile(executable).catch(() => null);
  if (!bytes || sha(bytes) !== expected) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Could not download the pinned Microsoft C++ runtime.');
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== expected) throw new Error('Microsoft C++ runtime checksum mismatch.');
    await writeFile(executable, bytes);
  }
  // These cabinet boundaries belong to this exact SHA-pinned Burn bundle.
  const payload = path.join(cache, 'payload.cab');
  const ux = path.join(cache, 'ux.cab');
  await writeFile(payload, bytes.subarray(686152, 686152 + 24939223));
  await writeFile(ux, bytes.subarray(479744, 479744 + 195988));
  const expand = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/expand.exe');
  const extract = (cab, filter, destination) => execFileSync(expand, [`-F:${filter}`, cab, destination], { windowsHide: true, stdio: 'pipe' });
  extract(payload, 'a12', cache);
  const crt = path.join(cache, 'a12');
  if (sha(await readFile(crt)) !== '640aa6c516c72444523b8fbe034db46ff4e118ed02705340e3ccb62d426ff040') throw new Error('The x64 CRT cabinet did not match the pinned bundle.');
  const dlls = path.join(cache, 'crt');
  await mkdir(dlls, { recursive: true });
  extract(crt, '*', dlls);
  for (const file of await readdir(dlls)) {
    if (file.endsWith('.dll_amd64')) await copyFile(path.join(dlls, file), path.join(pythonDirectory, file.replace(/_amd64$/, '')));
  }
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) await access(path.join(pythonDirectory, name));
  extract(ux, 'u4', cache);
  const license = path.join(cache, 'u4');
  if (sha(await readFile(license)) !== '8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b') throw new Error('Microsoft C++ runtime license checksum mismatch.');
  await copyFile(license, path.join(pythonDirectory, 'MICROSOFT-VC-RUNTIME-LICENSE.rtf'));
  await writeFile(path.join(pythonDirectory, 'MICROSOFT-VC-RUNTIME-REDISTRIBUTION.txt'), 'Still Motion Studio publisher redistribution notice\nMicrosoft runtime binaries: Copyright Microsoft Corporation. All rights reserved.\nPublisher redistribution is governed by the applicable licensed Visual Studio Distributable Code terms and REDIST list, not by the runtime end-user license alone.\nhttps://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution\nhttps://visualstudio.microsoft.com/license-terms/\nThe complete runtime end-user license is included alongside this notice. Binaries are unmodified; cabinet member suffixes are restored to their installed DLL filenames.\n');
  console.log('Microsoft C++ 14.44.35211 app-local runtime verified.');
}
