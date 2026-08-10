import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {renderBrightProfile} from '../lib/remotion-renderer.mjs';

const dataImage = async (file) =>
  `data:image/${path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${(await readFile(file)).toString('base64')}`;

const heroImage = await dataImage(path.resolve('assets', 'demo', 'hero.png'));
const scenes = [
  {id: 'hero', type: 'hero', start: 0, duration: 2, chapter: 'HỒ SƠ NHÀ SÁNG TẠO', subtitle: 'Một gương mặt đang chiếm trọn mọi dòng thời gian'},
  {id: 'claim', type: 'claim', start: 2, duration: 2, chapter: 'VÌ SAO NỔI TIẾNG?', words: ['NỔI TIẾNG', 'CHỈ SAU', '1 ĐÊM?']},
  {id: 'vertical', type: 'vertical', start: 4, duration: 2, chapter: 'KHOẢNH KHẮC BÙNG NỔ', heading: 'MỘT VIDEO THAY ĐỔI TẤT CẢ', subtitle: 'Fixture local.', mediaUrl: heroImage},
  {id: 'source', type: 'source', start: 6, duration: 2, chapter: 'TƯ LIỆU', mediaUrl: heroImage, source: 'LOCAL FIXTURE', label: 'SOURCE'},
  {id: 'social', type: 'social', start: 8, duration: 2, chapter: 'PHẢN ỨNG CỘNG ĐỒNG', quote: '“Controlled local smoke fixture.”'},
  {id: 'stats', type: 'stats', start: 10, duration: 2, chapter: 'SỨC ẢNH HƯỞNG', stats: [{value: '2,1M', label: 'NGƯỜI THEO DÕI'}, {value: '86M', label: 'LƯỢT XEM'}, {value: '#1', label: 'XU HƯỚNG'}]},
];

await renderBrightProfile({
  inputProps: {duration: 12, creatorName: 'EMIRU', heroImage, scenes, audioUrl: ''},
  outputLocation: path.resolve('data', 'bright-profile-smoke.mp4'),
  scale: 2 / 3,
  crf: 21,
});

console.log('data/bright-profile-smoke.mp4');
