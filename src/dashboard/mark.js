// Brand mark: a big "❯" prompt chevron + rising z's — matches assets/banner.svg.
// Pure data (no ink/react) so both the live dashboard (Logo.js) and the plain
// CLI formatters (tui.js) can consume it.

// Two diagonal strokes meeting in a point — reads as "❯" / ">".
export const CHEVRON = [
  '██▄    ',
  ' ▀██▄  ',
  '   ▀██▄',
  '   ▄██▀',
  ' ▄██▀  ',
  '██▀    ',
];

// Rising z's, aligned row-for-row with CHEVRON: each z spawns at the chevron
// tip and drifts up-right, growing as it goes — accumulate, then break off.
export const Z_FRAMES = [
  ['        ', '        ', ' z      ', '        ', '        ', '        '],
  ['        ', '   z    ', ' z      ', '        ', '        ', '        '],
  ['     Z  ', '   z    ', ' z      ', '        ', '        ', '        '],
  ['       Z', '     z  ', '        ', '        ', '        ', '        '],
  ['        ', '       z', '        ', '        ', '        ', '        '],
  ['        ', '        ', ' z      ', '        ', '        ', '        '],
];

// UNSNOOZE wordmark — ANSI-shadow block caps (71 cols, 6 rows, same height
// as the chevron). WORDMARK_SPLIT is where "UN" ends: amber to the left,
// bright to the right — matches the banner treatment.
export const WORDMARK = [
  '██╗   ██╗███╗   ██╗███████╗███╗   ██╗ ██████╗  ██████╗ ███████╗███████╗',
  '██║   ██║████╗  ██║██╔════╝████╗  ██║██╔═══██╗██╔═══██╗╚══███╔╝██╔════╝',
  '██║   ██║██╔██╗ ██║███████╗██╔██╗ ██║██║   ██║██║   ██║  ███╔╝ █████╗  ',
  '██║   ██║██║╚██╗██║╚════██║██║╚██╗██║██║   ██║██║   ██║ ███╔╝  ██╔══╝  ',
  '╚██████╔╝██║ ╚████║███████║██║ ╚████║╚██████╔╝╚██████╔╝███████╗███████╗',
  ' ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚══════╝╚══════╝',
];
export const WORDMARK_SPLIT = 19; // '██╗   ██╗' (U) + '███╗   ██╗' (N)

export const TAGLINE = '❯ wakes every limit-stopped AI session the moment the limit resets';

// One-line mark for compact chrome (footers, tiny terminals).
export const MARK_LINE = '❯ z z z';

export function markRows(frame = 2) {
  const zs = Z_FRAMES[((frame % Z_FRAMES.length) + Z_FRAMES.length) % Z_FRAMES.length];
  return CHEVRON.map((row, i) => ({ chevron: row, zs: zs[i] || '' }));
}

export function markPlainText(frame = 2) {
  return markRows(frame).map(r => (r.chevron + ' ' + r.zs).trimEnd()).join('\n');
}
