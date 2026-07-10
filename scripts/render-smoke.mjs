import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {renderBrightProfile} from '../lib/remotion-renderer.mjs';

const dataImage = async (file) =>
  `data:image/${path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${(await readFile(file)).toString('base64')}`;

const heroImage = await dataImage(path.resolve('assets', 'demo', 'hero.png'));
const scenes = [
  {id: 'hero', type: 'hero', start: 0, duration: 6, chapter: 'HỒ SƠ NHÀ SÁNG TẠO', subtitle: 'Một gương mặt đang chiếm trọn mọi dòng thời gian'},
  {id: 'claim', type: 'claim', start: 6, duration: 5, chapter: 'VÌ SAO CÔ ẤY NỔI TIẾNG?', words: ['NỔI TIẾNG', 'CHỈ SAU', '1 ĐÊM?']},
  {id: 'vertical', type: 'vertical', start: 11, duration: 6, chapter: 'KHOẢNH KHẮC BÙNG NỔ', heading: 'MỘT VIDEO THAY ĐỔI TẤT CẢ', subtitle: 'Chỉ sau vài giờ, đoạn clip đã xuất hiện ở khắp mọi nền tảng.'},
  {id: 'social', type: 'social', start: 17, duration: 6, chapter: 'PHẢN ỨNG CỘNG ĐỒNG', quote: '“Tôi không nghĩ một khoảnh khắc bình thường lại có thể lan truyền nhanh đến vậy.”'},
  {id: 'stats', type: 'stats', start: 23, duration: 7, chapter: 'SỨC ẢNH HƯỞNG', stats: [{value: '2,1M', label: 'NGƯỜI THEO DÕI'}, {value: '86M', label: 'LƯỢT XEM'}, {value: '#1', label: 'XU HƯỚNG'}]},
];

await renderBrightProfile({
  inputProps: {duration: 30, creatorName: 'EMIRU', heroImage, scenes, audioUrl: ''},
  outputLocation: path.resolve('data', 'bright-profile-smoke.mp4'),
  scale: 2 / 3,
  crf: 21,
});

console.log('data/bright-profile-smoke.mp4');
