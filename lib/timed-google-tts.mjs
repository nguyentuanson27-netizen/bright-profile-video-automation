import path from 'node:path';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import textToSpeech from '@google-cloud/text-to-speech';

const {TextToSpeechClient} = textToSpeech;

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
});

const probeDuration = (file) => new Promise((resolve, reject) => {
  const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
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

export async function generateTimedGoogleTts({manifest, output, workDir, onChunk}) {
  const client = new TextToSpeechClient();
  const languageCode = process.env.GOOGLE_TTS_LANGUAGE || 'vi-VN';
  const voiceName = process.env.GOOGLE_TTS_VOICE || 'vi-VN-Neural2-D';
  const defaultRate = Number(process.env.GOOGLE_TTS_SPEAKING_RATE || 1.03);
  const maxSpeed = Number(process.env.TTS_MAX_SPEED || 1.35);
  const endGap = Number(process.env.TTS_END_GAP_SECONDS || 0.18);
  const chunks = [...manifest.chunks].sort((a, b) => Number(a.start) - Number(b.start));
  const totalDuration = Number(manifest.duration);
  const temp = path.join(workDir, 'tts-temp');
  await rm(temp, {recursive: true, force: true});
  await mkdir(temp, {recursive: true});
  const timeline = [];
  let cursor = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const start = Number(chunk.start);
    const slot = Number(chunk.duration);
    if (start > cursor + 0.001) {
      const silence = path.join(temp, `${String(index).padStart(2, '0')}-gap.wav`);
      await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', (start - cursor).toFixed(6), '-c:a', 'pcm_s16le', silence]);
      timeline.push(silence);
    }

    const [response] = await client.synthesizeSpeech({
      input: {text: String(chunk.text)},
      voice: {languageCode, name: chunk.voice || voiceName},
      audioConfig: {audioEncoding: 'MP3', speakingRate: Number(chunk.speakingRate || defaultRate)},
    });
    const raw = path.join(temp, `${String(index).padStart(2, '0')}-raw.mp3`);
    const audioContent = typeof response.audioContent === 'string'
      ? Buffer.from(response.audioContent, 'base64')
      : Buffer.from(response.audioContent);
    await writeFile(raw, audioContent);
    const rawDuration = await probeDuration(raw);
    const contentTarget = Math.max(0.5, slot - endGap);
    const requiredSpeed = Math.max(1, rawDuration / contentTarget);
    if (requiredSpeed > maxSpeed) {
      throw new Error(`TTS chunk ${chunk.id || index} needs speed ${requiredSpeed.toFixed(3)}, above max ${maxSpeed.toFixed(3)}`);
    }
    const fitted = path.join(temp, `${String(index).padStart(2, '0')}-fitted.wav`);
    await run('ffmpeg', ['-y', '-i', raw, '-af', `${atempoChain(requiredSpeed)},apad,atrim=0:${slot.toFixed(6)}`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', fitted]);
    timeline.push(fitted);
    cursor = start + slot;
    onChunk?.({id: chunk.id || String(index), slot, rawDuration, speed: requiredSpeed});
  }

  if (cursor < totalDuration - 0.001) {
    const tail = path.join(temp, '99-tail.wav');
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', (totalDuration - cursor).toFixed(6), '-c:a', 'pcm_s16le', tail]);
    timeline.push(tail);
  }

  const concat = path.join(temp, 'concat.txt');
  await writeFile(concat, timeline.map((item) => `file '${item.replaceAll("'", "'\\''")}'\n`).join(''));
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concat, '-t', totalDuration.toFixed(6), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'libmp3lame', '-b:a', '128k', output]);
  await readFile(output);
  return {output, duration: await probeDuration(output), voice: voiceName, language: languageCode};
}
