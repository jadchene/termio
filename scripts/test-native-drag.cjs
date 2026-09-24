const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Windows Shell drag tests require Windows.');
  process.exit(0);
}

const project = path.resolve(__dirname, '..');
const scratchParent = path.resolve(process.env.TERMIO_TEST_ROOT || os.tmpdir());
fs.mkdirSync(scratchParent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchParent, 'termio-native-test-'));
const compiler = ['Framework64', 'Framework']
  .map((framework) => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
  .find((candidate) => fs.existsSync(candidate));

/** 执行带退出保护的原生测试，不打开业务应用或接触用户目录。 */
const run = (program, args) => {
  const result = spawnSync(program, args, { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 25000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native drag test exited with ${result.status}`);
};

try {
  if (!compiler) throw new Error('.NET Framework C# compiler not found');
  const executable = path.join(scratch, 'shell-drag-tests.exe');
  run(compiler, [
    '/nologo', '/target:exe', '/main:ShellDropCheck', `/out:${executable}`,
    '/reference:System.Web.Extensions.dll',
    path.join(project, 'native/windows-virtual-file-drag/VirtualFileDrag.cs'),
    path.join(project, 'tests/native/ShellDropCheck.cs'),
  ]);
  for (const scenario of ['file', 'directory', 'directory-empty', 'hover-cancel', 'file-cancel', 'directory-cancel', 'failure', 'disconnect', 'repeat', 'cross-file', 'cross-directory']) {
    run(executable, [path.join(scratch, scenario), scenario]);
  }
} finally {
  // 只清理本次 mkdtemp 创建的子目录，拒绝删除父目录或目录外路径。
  const relative = path.relative(scratchParent, path.resolve(scratch));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(scratch, { recursive: true, force: true });
}
