import { spawn } from 'node:child_process';

export function startMediaProcess(executable, args, { environment, output = 'pipe' } = {}) {
  return spawn(executable, args, { shell: false, windowsHide: true, env: environment, stdio: ['ignore', output, 'pipe'] });
}
