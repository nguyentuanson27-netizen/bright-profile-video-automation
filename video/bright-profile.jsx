import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const colors = {
  cyan: '#27d7ff',
  blue: '#1677ff',
  violet: '#7545ff',
  yellow: '#ffe75a',
  pink: '#ff4f9a',
  red: '#ff405d',
  ink: '#071427',
  white: '#ffffff',
};

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const font = '"Noto Sans", Arial, sans-serif';

const isVideoMedia = (value = '') => /\.(mp4|mov|m4v|webm|mkv)(\?|#|$)/i.test(value);

const Media = ({src, style, muted = true}) => {
  if (!src) return null;
  if (isVideoMedia(src)) return <OffthreadVideo src={src} muted={muted} style={style} />;
  return <Img src={src} style={style} />;
};

const enter = (frame, fps, delay = 0) =>
  spring({frame: frame - delay, fps, config: {damping: 13, stiffness: 125, mass: 0.72}});

const sceneOpacity = (frame, durationFrames) =>
  interpolate(frame, [0, 10, Math.max(11, durationFrames - 10), durationFrames], [0, 1, 1, 0], clamp);

const Background = ({image, dark = 0.18}) => (
  <AbsoluteFill style={{overflow: 'hidden', background: 'linear-gradient(135deg,#39dcff,#6b45ff)'}}>
    {image ? (
      <Img
        src={image}
        style={{
          position: 'absolute',
          inset: '-8%',
          width: '116%',
          height: '116%',
          objectFit: 'cover',
          filter: 'blur(38px) saturate(1.35)',
          opacity: 0.68,
          transform: 'scale(1.08)',
        }}
      />
    ) : null}
    <AbsoluteFill style={{background: `rgba(2,15,36,${dark})`}} />
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(circle at 78% 28%,rgba(255,255,255,.35),transparent 25%), radial-gradient(circle at 15% 85%,rgba(255,79,154,.35),transparent 30%), linear-gradient(100deg,rgba(4,18,42,.38),transparent 56%)',
      }}
    />
  </AbsoluteFill>
);

const BrandHeader = ({chapter = 'HỒ SƠ NHÀ SÁNG TẠO'}) => (
  <>
    <div style={{position: 'absolute', left: 62, top: 42, zIndex: 50, color: colors.white, fontFamily: font, fontWeight: 800, fontSize: 19, letterSpacing: 1.2, textShadow: '0 2px 8px rgba(0,0,0,.45)'}}>
      <span style={{color: colors.pink}}>●</span> {chapter}
    </div>
    <div style={{position: 'absolute', right: 62, top: 40, zIndex: 50, color: colors.white, fontFamily: font, fontWeight: 900, fontSize: 20, letterSpacing: 1.5, textShadow: '0 2px 8px rgba(0,0,0,.45)'}}>
      BRIGHT PROFILE
    </div>
  </>
);

const FloatingBadge = ({children, x, y, delay, rotate = 0, color = colors.violet}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = enter(frame, fps, delay);
  const bob = Math.sin((frame + delay * 3) / 13) * 7;
  return (
    <div style={{position: 'absolute', left: x, top: y + bob, transform: `scale(${p}) rotate(${rotate}deg)`, opacity: p, padding: '14px 24px', borderRadius: 24, background: color, color: 'white', fontFamily: font, fontSize: 26, fontWeight: 900, boxShadow: '0 16px 38px rgba(0,0,0,.28)', border: '2px solid rgba(255,255,255,.7)'}}>
      {children}
    </div>
  );
};

const HeroSubject = ({scene, heroImage, creatorName}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const p = enter(frame, fps, 3);
  const title = enter(frame, fps, 12);
  const camera = interpolate(frame, [0, durationInFrames], [1.02, 1.09], clamp);
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames)}}>
      <Background image={heroImage} />
      <BrandHeader chapter={scene.chapter} />
      <div style={{position: 'absolute', left: 90, top: 250, width: 820, zIndex: 20, transform: `translateY(${(1 - title) * 45}px)`, opacity: title, color: 'white', fontFamily: font}}>
        <div style={{fontSize: 27, fontWeight: 900, color: colors.yellow, letterSpacing: 2}}>TỪ MỘT GƯƠNG MẶT MỚI...</div>
        <div style={{fontSize: 108, lineHeight: 0.96, fontWeight: 950, letterSpacing: -4, marginTop: 18, textShadow: '0 10px 35px rgba(0,0,0,.3)'}}>{creatorName}</div>
        <div style={{fontSize: 42, lineHeight: 1.18, fontWeight: 800, marginTop: 24, maxWidth: 760}}>{scene.subtitle}</div>
      </div>
      {heroImage ? <Img src={heroImage} style={{position: 'absolute', right: 80, bottom: -25, width: 820, height: 1010, objectFit: 'contain', objectPosition: 'center bottom', transform: `scale(${p * camera})`, transformOrigin: 'center bottom', filter: 'drop-shadow(0 35px 45px rgba(0,0,0,.35))'}} /> : null}
      <FloatingBadge x={1030} y={165} delay={18} rotate={-7} color={colors.pink}>♥ 2,1M</FloatingBadge>
      <FloatingBadge x={1480} y={280} delay={25} rotate={8} color={colors.violet}>LIVE</FloatingBadge>
      <FloatingBadge x={1110} y={750} delay={32} rotate={4} color={colors.blue}>#VIRAL</FloatingBadge>
    </AbsoluteFill>
  );
};

const BigClaimText = ({scene, heroImage}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const words = scene.words || ['NỔI TIẾNG', 'TRANH CÃI', 'SỰ THẬT'];
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames), background: colors.ink}}>
      <Background image={heroImage} dark={0.55} />
      <BrandHeader chapter={scene.chapter} />
      <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 42}}>
        {words.map((word, index) => {
          const p = enter(frame, fps, 8 + index * 9);
          return <div key={word} style={{transform: `translateY(${(1 - p) * 90}px) rotate(${index % 2 ? 2 : -2}deg) scale(${0.72 + p * 0.28})`, opacity: p, color: index === 1 ? colors.red : index === 2 ? colors.yellow : colors.white, fontFamily: font, fontWeight: 950, fontSize: index === 1 ? 112 : 86, lineHeight: 0.9, textAlign: 'center', textShadow: '0 12px 35px rgba(0,0,0,.45)', maxWidth: 520}}>{word}</div>;
        })}
      </div>
      <div style={{position: 'absolute', left: 360, right: 360, bottom: 180, height: 5, background: 'rgba(255,255,255,.25)'}}><div style={{height: '100%', width: `${interpolate(frame, [5, durationInFrames - 8], [0, 100], clamp)}%`, background: colors.pink}} /></div>
    </AbsoluteFill>
  );
};

const VerticalEvidence = ({scene, heroImage}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const p = enter(frame, fps, 5);
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames)}}>
      <Background image={heroImage} dark={0.28} />
      <BrandHeader chapter={scene.chapter} />
      <div style={{position: 'absolute', left: 190, top: 230, width: 720, color: 'white', fontFamily: font}}>
        <div style={{fontSize: 31, color: colors.yellow, fontWeight: 900}}>KHOẢNH KHẮC BÙNG NỔ</div>
        <div style={{fontSize: 70, lineHeight: 1.06, fontWeight: 950, marginTop: 18}}>{scene.heading}</div>
        <div style={{fontSize: 32, lineHeight: 1.35, marginTop: 28, opacity: 0.9}}>{scene.subtitle}</div>
      </div>
      <div style={{position: 'absolute', right: 230, top: 120, width: 520, height: 840, borderRadius: 45, background: '#111', border: '10px solid rgba(255,255,255,.92)', overflow: 'hidden', boxShadow: '0 40px 80px rgba(0,0,0,.38)', transform: `translateX(${(1 - p) * 120}px) rotate(${(1 - p) * 8 - 3}deg)`, opacity: p}}>
        <Media src={scene.mediaUrl || heroImage} muted={scene.muted !== false} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
        <div style={{position: 'absolute', left: 25, bottom: 25, padding: '12px 18px', borderRadius: 16, background: colors.red, color: 'white', fontFamily: font, fontSize: 23, fontWeight: 900}}>● LIVE</div>
      </div>
    </AbsoluteFill>
  );
};

const SourceClip = ({scene, heroImage}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const media = scene.mediaUrl || heroImage;
  const zoom = interpolate(frame, [0, durationInFrames], [1.01, 1.055], clamp);
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames), background: colors.ink, overflow: 'hidden'}}>
      <Media src={media} muted={scene.muted !== false} style={{position: 'absolute', inset: '-6%', width: '112%', height: '112%', objectFit: 'cover', filter: 'blur(34px) brightness(.58)', transform: `scale(${zoom})`}} />
      <div style={{position: 'absolute', left: 260, right: 260, top: 90, bottom: 90, overflow: 'hidden', borderRadius: 30, background: '#05080f', boxShadow: '0 35px 85px rgba(0,0,0,.48)', border: '3px solid rgba(255,255,255,.62)'}}>
        <Media src={media} muted={scene.muted !== false} style={{width: '100%', height: '100%', objectFit: scene.fit || 'contain'}} />
      </div>
      <BrandHeader chapter={scene.chapter || 'TƯ LIỆU'} />
      {scene.source ? <div style={{position: 'absolute', right: 75, bottom: 42, zIndex: 60, color: 'white', fontFamily: font, fontSize: 18, fontWeight: 800, opacity: .82}}>NGUỒN: {scene.source}</div> : null}
      {scene.label ? <div style={{position: 'absolute', left: 295, bottom: 125, zIndex: 60, padding: '13px 20px', borderRadius: 15, background: colors.red, color: 'white', fontFamily: font, fontSize: 22, fontWeight: 950}}>{scene.label}</div> : null}
    </AbsoluteFill>
  );
};

const SocialPost = ({scene, heroImage, creatorName}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const p = enter(frame, fps, 7);
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames)}}>
      <Background image={heroImage} dark={0.48} />
      <BrandHeader chapter={scene.chapter} />
      <div style={{position: 'absolute', left: 210, right: 210, top: 230, minHeight: 530, borderRadius: 40, background: 'rgba(255,255,255,.96)', boxShadow: '0 45px 90px rgba(0,0,0,.35)', padding: 55, transform: `translateY(${(1 - p) * 80}px) rotate(${(1 - p) * -2}deg)`, opacity: p, fontFamily: font, color: '#18243a'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 24}}>
          <div style={{width: 92, height: 92, borderRadius: '50%', background: `linear-gradient(135deg,${colors.cyan},${colors.violet})`, overflow: 'hidden'}}>{heroImage ? <Img src={heroImage} style={{width: '100%', height: '100%', objectFit: 'cover'}} /> : null}</div>
          <div><div style={{fontSize: 35, fontWeight: 950}}>{creatorName} <span style={{color: colors.blue}}>●</span></div><div style={{fontSize: 23, color: '#708098'}}>@creator · 2 giờ trước</div></div>
        </div>
        <div style={{fontSize: 48, lineHeight: 1.3, marginTop: 44, fontWeight: 780}}>{scene.quote}</div>
        <div style={{display: 'flex', gap: 70, marginTop: 48, fontSize: 27, color: '#66758c', fontWeight: 800}}><span>♥ 86K</span><span>↻ 12K</span><span>◉ 4,8M lượt xem</span></div>
      </div>
    </AbsoluteFill>
  );
};

const CreatorStats = ({scene, heroImage, creatorName}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const stats = scene.stats || [];
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, durationInFrames)}}>
      <Background image={heroImage} dark={0.38} />
      <BrandHeader chapter={scene.chapter} />
      <div style={{position: 'absolute', left: 130, top: 205, color: 'white', fontFamily: font, fontSize: 72, lineHeight: 1.05, fontWeight: 950, width: 740}}>{creatorName}<br/><span style={{color: colors.yellow}}>TRONG NHỮNG CON SỐ</span></div>
      <div style={{position: 'absolute', left: 130, right: 130, bottom: 155, display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, stats.length)},1fr)`, gap: 30}}>
        {stats.map((stat, index) => {
          const p = enter(frame, fps, 10 + index * 8);
          return <div key={stat.label} style={{height: 285, borderRadius: 34, padding: 40, background: 'rgba(255,255,255,.93)', boxShadow: '0 30px 60px rgba(0,0,0,.28)', transform: `translateY(${(1 - p) * 80}px) scale(${0.8 + p * 0.2})`, opacity: p, fontFamily: font}}><div style={{fontSize: 78, fontWeight: 950, color: index === 1 ? colors.pink : colors.blue}}>{stat.value}</div><div style={{fontSize: 28, fontWeight: 850, color: '#26334b', marginTop: 24}}>{stat.label}</div></div>;
        })}
      </div>
    </AbsoluteFill>
  );
};

const Scene = ({scene, heroImage, creatorName}) => {
  if (scene.type === 'claim') return <BigClaimText scene={scene} heroImage={heroImage} />;
  if (scene.type === 'vertical') return <VerticalEvidence scene={scene} heroImage={heroImage} />;
  if (scene.type === 'source') return <SourceClip scene={scene} heroImage={heroImage} />;
  if (scene.type === 'social') return <SocialPost scene={scene} heroImage={heroImage} creatorName={creatorName} />;
  if (scene.type === 'stats') return <CreatorStats scene={scene} heroImage={heroImage} creatorName={creatorName} />;
  return <HeroSubject scene={scene} heroImage={heroImage} creatorName={creatorName} />;
};

export const BrightCreatorProfile = ({scenes = [], heroImage = '', creatorName = 'CREATOR', audioUrl = ''}) => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: colors.ink}}>
      {audioUrl ? <Audio src={audioUrl} /> : null}
      {scenes.map((scene) => (
        <Sequence key={scene.id} from={Math.round(scene.start * fps)} durationInFrames={Math.max(1, Math.round(scene.duration * fps))} premountFor={fps}>
          <Scene scene={scene} heroImage={heroImage} creatorName={creatorName} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
