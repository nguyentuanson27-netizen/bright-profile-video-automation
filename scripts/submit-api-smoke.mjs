import {readFile, writeFile} from 'node:fs/promises';

const baseUrl = process.env.BRIGHT_API_URL || 'http://127.0.0.1:4180';
const token = process.env.BRIGHT_API_TOKEN;
if (!token) throw new Error('BRIGHT_API_TOKEN is required');

const request = JSON.parse(await readFile('/app/examples/api-request.json', 'utf8'));
const createdResponse = await fetch(`${baseUrl}/jobs`, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-bright-api-key': token},
  body: JSON.stringify(request),
});
if (!createdResponse.ok) throw new Error(`Create failed ${createdResponse.status}: ${await createdResponse.text()}`);
const created = await createdResponse.json();
console.log(JSON.stringify({event: 'created', ...created}));

let lastStage = '';
for (let attempt = 0; attempt < 120; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const statusResponse = await fetch(`${baseUrl}${created.statusUrl}`, {headers: {'x-bright-api-key': token}});
  if (!statusResponse.ok) throw new Error(`Status failed ${statusResponse.status}: ${await statusResponse.text()}`);
  const status = await statusResponse.json();
  if (status.stage !== lastStage) {
    console.log(JSON.stringify({event: 'stage', id: created.id, status: status.status, stage: status.stage}));
    lastStage = status.stage;
  }
  if (status.status === 'failed') throw new Error(status.error || 'Job failed');
  if (status.status === 'completed') {
    const download = await fetch(`${baseUrl}${created.downloadUrl}`, {headers: {'x-bright-api-key': token}});
    if (!download.ok) throw new Error(`Download failed ${download.status}: ${await download.text()}`);
    const output = '/app/data/api-smoke-output.mp4';
    await writeFile(output, Buffer.from(await download.arrayBuffer()));
    console.log(JSON.stringify({event: 'downloaded', id: created.id, output}));
    process.exit(0);
  }
}

throw new Error('Timed out waiting for API job');
