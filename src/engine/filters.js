// Color filters: lift/gamma/gain grades with split toning, mixed by an intensity slider.

const ID = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadowTint: [0, 0, 0],
  highTint: [0, 0, 0],
  tone: [1, 1, 1],
  sat: 0,
  contrast: 0,
  fade: 0,
  mono: 0,
};

const F = (id, name, cat, g) => ({ id, name, cat, grade: { ...ID, ...g } });

export const FILTERS = [
  F('teal-orange', 'Teal & Orange', 'Cinematic', { shadowTint: [-0.04, 0.03, 0.07], highTint: [0.07, 0.02, -0.06], contrast: 0.12, sat: 0.1 }),
  F('blockbuster', 'Blockbuster', 'Cinematic', { lift: [0.0, 0.02, 0.04], gain: [1.06, 1.0, 0.93], contrast: 0.22, sat: -0.05, shadowTint: [-0.03, 0.02, 0.05] }),
  F('moody', 'Moody', 'Cinematic', { gamma: [0.92, 0.95, 1.0], contrast: 0.15, sat: -0.3, fade: 0.25, shadowTint: [0.0, 0.02, 0.04] }),
  F('noir', 'Noir', 'Cinematic', { mono: 1, contrast: 0.45, gamma: [0.9, 0.9, 0.9] }),
  F('bleach', 'Bleach Bypass', 'Cinematic', { sat: -0.55, contrast: 0.35, gain: [1.04, 1.04, 1.04] }),
  F('dune', 'Desert', 'Cinematic', { gain: [1.1, 1.0, 0.82], lift: [0.04, 0.02, 0.0], sat: -0.1, contrast: 0.1 }),
  F('matrix', 'Code Green', 'Cinematic', { gain: [0.85, 1.08, 0.85], shadowTint: [-0.02, 0.04, 0.0], contrast: 0.18, sat: -0.2 }),
  F('neon-noir', 'Neon Noir', 'Cinematic', { shadowTint: [0.03, -0.02, 0.08], highTint: [0.06, -0.03, 0.05], contrast: 0.2, sat: 0.15 }),
  F('soft-skin', 'Soft Skin', 'Portrait', { gain: [1.04, 1.01, 0.98], fade: 0.12, contrast: -0.06, sat: -0.05 }),
  F('peach', 'Peach', 'Portrait', { highTint: [0.06, 0.02, 0.0], shadowTint: [0.02, 0.0, 0.02], gamma: [1.05, 1.02, 1.0], sat: 0.05 }),
  F('rosy', 'Rosy', 'Portrait', { gain: [1.06, 0.98, 1.02], highTint: [0.04, 0.0, 0.03], fade: 0.08 }),
  F('clean', 'Clean Bright', 'Portrait', { gamma: [1.12, 1.12, 1.12], contrast: 0.06, sat: 0.08 }),
  F('porcelain', 'Porcelain', 'Portrait', { gamma: [1.1, 1.1, 1.14], sat: -0.25, fade: 0.1, highTint: [0.0, 0.01, 0.03] }),
  F('kodak70', '70s Film', 'Vintage', { lift: [0.05, 0.03, 0.0], gain: [1.05, 0.98, 0.85], sat: -0.12, fade: 0.2, contrast: 0.05 }),
  F('polaroid', 'Instant', 'Vintage', { lift: [0.04, 0.05, 0.07], gain: [1.02, 1.0, 0.92], fade: 0.25, sat: -0.15, highTint: [0.03, 0.02, 0.0] }),
  F('faded', 'Faded', 'Vintage', { fade: 0.45, sat: -0.2, contrast: -0.1 }),
  F('sepia-film', 'Sepia Film', 'Vintage', { mono: 1, tone: [1.1, 0.96, 0.78], fade: 0.15 }),
  F('cross', 'Cross Process', 'Vintage', { gain: [1.0, 1.08, 0.82], lift: [0.0, 0.0, 0.08], contrast: 0.2, sat: 0.15 }),
  F('lomo', 'Lomo', 'Vintage', { contrast: 0.35, sat: 0.25, shadowTint: [0.0, 0.02, 0.06], gain: [1.05, 1.02, 0.95] }),
  F('vivid', 'Vivid', 'Life', { sat: 0.35, contrast: 0.12 }),
  F('golden', 'Golden Hour', 'Life', { gain: [1.1, 1.02, 0.86], highTint: [0.05, 0.03, 0.0], sat: 0.1 }),
  F('cold', 'Cold Blue', 'Life', { gain: [0.92, 0.99, 1.1], shadowTint: [0.0, 0.01, 0.04], sat: -0.08 }),
  F('forest', 'Forest', 'Life', { gain: [0.95, 1.05, 0.95], shadowTint: [-0.02, 0.03, 0.0], sat: 0.08, contrast: 0.08 }),
  F('sunset', 'Sunset', 'Life', { gain: [1.12, 0.96, 0.9], highTint: [0.05, 0.0, 0.03], shadowTint: [0.02, -0.01, 0.04], sat: 0.15 }),
  F('night-city', 'Night City', 'Life', { shadowTint: [0.0, 0.0, 0.06], highTint: [0.06, 0.03, 0.0], contrast: 0.18, sat: 0.12 }),
  F('food', 'Tasty', 'Life', { gain: [1.06, 1.02, 0.94], sat: 0.25, contrast: 0.08, gamma: [1.05, 1.05, 1.05] }),
  F('pastel', 'Pastel', 'Style', { fade: 0.3, sat: -0.15, gamma: [1.1, 1.08, 1.12], highTint: [0.02, 0.0, 0.04] }),
  F('candy', 'Candy', 'Style', { sat: 0.45, gain: [1.05, 0.98, 1.06], contrast: 0.05 }),
  F('cyberpunk', 'Cyberpunk', 'Style', { shadowTint: [0.04, -0.02, 0.1], highTint: [0.08, 0.0, -0.02], sat: 0.25, contrast: 0.2 }),
  F('matte', 'Matte', 'Style', { fade: 0.35, contrast: 0.1, sat: -0.08 }),
  F('bw-high', 'B&W Punch', 'Style', { mono: 1, contrast: 0.5 }),
  F('bw-soft', 'B&W Soft', 'Style', { mono: 1, fade: 0.2, contrast: -0.05 }),
];

export const FILTER_CATEGORIES = ['Cinematic', 'Portrait', 'Vintage', 'Life', 'Style'];

export const filterById = new Map(FILTERS.map((f) => [f.id, f]));

const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

// Mixes a filter toward identity. Returns null when it would change nothing.
export function gradeFor(filter) {
  if (!filter || !filter.id) return null;
  const f = filterById.get(filter.id);
  if (!f) return null;
  const k = filter.intensity === undefined ? 1 : filter.intensity;
  if (k <= 0) return null;
  const g = f.grade;
  return {
    lift: lerp3(ID.lift, g.lift, k),
    gamma: lerp3(ID.gamma, g.gamma, k),
    gain: lerp3(ID.gain, g.gain, k),
    shadowTint: lerp3(ID.shadowTint, g.shadowTint, k),
    highTint: lerp3(ID.highTint, g.highTint, k),
    tone: lerp3(ID.tone, g.tone, k),
    sat: lerp(0, g.sat, k),
    contrast: lerp(0, g.contrast, k),
    fade: lerp(0, g.fade, k),
    mono: lerp(0, g.mono, k),
  };
}

export const IDENTITY_GRADE = ID;
