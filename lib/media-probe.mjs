import {spawn} from 'node:child_process';
import {AppError} from '../domain/errors.mjs';

export function probeVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], {stdio: ['ignore', 'pipe', 'ignore']});
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => reject(new AppError(
      'VIDEO_PROBE_UNAVAILABLE',
      'Video output validation is unavailable',
      {status: 503, retryable: true},
    )));
    child.on('close', (code) => {
      const duration = Number(stdout.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
        reject(new AppError('RENDER_OUTPUT_INVALID', 'Rendered video is corrupt', {status: 409}));
        return;
      }
      resolve(duration);
    });
  });
}
