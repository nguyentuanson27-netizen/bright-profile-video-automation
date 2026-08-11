import path from 'node:path';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {AppError} from '../domain/errors.mjs';
import {createGeminiTtsProvider} from '../providers/tts/gemini.mjs';

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => code === 0
    ? resolve()
    : reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
});

const probe = (file) => new Promise((resolve, reject) => {
  const child = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve(Number(stdout.trim())) : reject(new Error(stderr)));
});

const atempoChain = (inputSpeed) => {
  let speed = inputSpeed;
  const filters = [];
  while (speed > 2) { filters.push('atempo=2'); speed /= 2; }
  while (speed < 0.5) { filters.push('atempo=0.5'); speed /= 0.5; }
  filters.push(`atempo=${speed.toFixed(6)}`);
  return filters.join(',');
};

const pcmDuration = ({pcm, sampleRate, channels, sampleWidth}) => {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
    throw new AppError('TTS_OUTPUT_INVALID', 'Gemini TTS returned empty PCM audio', {status: 502});
  }
  if (sampleWidth !== 2 || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new AppError('TTS_OUTPUT_INVALID', 'Gemini TTS returned unsupported PCM metadata', {status: 502});
  }
  const duration = pcm.length / (sampleRate * channels * sampleWidth);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('TTS_OUTPUT_INVALID', 'Gemini TTS returned invalid PCM duration', {status: 502});
  }
  return duration;
};

export async function generateTimedGeminiTts({
  manifest,
  output,
  workDir,
  onChunk,
  ttsProvider = createGeminiTtsProvider(),
  runCommand = run,
  probeDuration = probe,
  env = process.env,
}) {
  if (!ttsProvider?.synthesize) throw new TypeError('ttsProvider is required');
  const maxSpeed = Number(env.TTS_MAX_SPEED || 1.35);
  const endGap = Number(env.TTS_END_GAP_SECONDS || 0.18);
  const chunks = [...manifest.chunks].sort((a, b) => Number(a.start) - Number(b.start));
  const totalDuration = Number(manifest.duration);
  const temp = path.join(workDir, 'tts-temp');
  await rm(temp, {recursive: true, force: true});
  await mkdir(temp, {recursive: true});
  const timeline = [];
  const voices = new Set();
  const models = new Set();
  let cursor = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const start = Number(chunk.start);
    const slot = Number(chunk.duration);
    if (start > cursor + 0.001) {
      const silence = path.join(temp, `${String(index).padStart(2, '0')}-gap.wav`);
      await runCommand('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', (start - cursor).toFixed(6), '-c:a', 'pcm_s16le', silence,
      ]);
      timeline.push(silence);
    }

    const synthesized = await ttsProvider.synthesize({
      text: String(chunk.text),
      ...(chunk.voice ? {voice: chunk.voice} : {}),
    });
    const rawDuration = pcmDuration(synthesized);
    voices.add(synthesized.voice);
    models.add(synthesized.model);
    const raw = path.join(temp, `${String(index).padStart(2, '0')}-raw.pcm`);
    await writeFile(raw, synthesized.pcm);

    const contentTarget = Math.max(0.5, slot - endGap);
    const requiredSpeed = Math.max(1, rawDuration / contentTarget);
    if (requiredSpeed > maxSpeed) {
      throw new AppError(
        'TTS_TIMING_EXCEEDED',
        `TTS chunk ${chunk.id || index} needs speed ${requiredSpeed.toFixed(3)}, above max ${maxSpeed.toFixed(3)}`,
        {status: 409},
      );
    }

    const fitted = path.join(temp, `${String(index).padStart(2, '0')}-fitted.wav`);
    await runCommand('ffmpeg', [
      '-y',
      '-f', 's16le',
      '-ar', String(synthesized.sampleRate),
      '-ac', String(synthesized.channels),
      '-i', raw,
      '-af', `${atempoChain(requiredSpeed)},apad,atrim=0:${slot.toFixed(6)}`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
      fitted,
    ]);
    timeline.push(fitted);
    cursor = start + slot;
    onChunk?.({
      id: chunk.id || String(index),
      slot,
      rawDuration,
      speed: requiredSpeed,
      voice: synthesized.voice,
    });
  }

  if (cursor < totalDuration - 0.001) {
    const tail = path.join(temp, '99-tail.wav');
    await runCommand('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', (totalDuration - cursor).toFixed(6), '-c:a', 'pcm_s16le', tail,
    ]);
    timeline.push(tail);
  }

  if (timeline.length === 0) {
    throw new AppError('TTS_INPUT_INVALID', 'Timed TTS manifest contains no audio chunks', {status: 500});
  }

  const concat = path.join(temp, 'concat.txt');
  await writeFile(concat, timeline.map((item) => `file '${item.replaceAll("'", "'\\''")}'\n`).join(''));
  await runCommand('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concat,
    '-t', totalDuration.toFixed(6),
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'libmp3lame', '-b:a', '128k',
    output,
  ]);
  await readFile(output);
  const duration = await probeDuration(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('TTS_OUTPUT_INVALID', 'Timed Gemini TTS output has invalid duration', {status: 500});
  }

  return {
    output,
    duration,
    voice: voices.size === 1 ? [...voices][0] : 'mixed',
    model: models.size === 1 ? [...models][0] : 'mixed',
  };
}
