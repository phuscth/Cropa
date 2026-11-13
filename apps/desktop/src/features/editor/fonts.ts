import latin600 from '@fontsource/inter/files/inter-latin-600-normal.woff2?url';
import latin700 from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';
import latinExt600 from '@fontsource/inter/files/inter-latin-ext-600-normal.woff2?url';
import latinExt700 from '@fontsource/inter/files/inter-latin-ext-700-normal.woff2?url';
import vietnamese600 from '@fontsource/inter/files/inter-vietnamese-600-normal.woff2?url';
import vietnamese700 from '@fontsource/inter/files/inter-vietnamese-700-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const VIETNAMESE =
  'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB';

// The renderer draws text at weight 600 and step numbers at 700.
const FACES: readonly { url: string; weight: string; range: string }[] = [
  { url: latin600, weight: '600', range: LATIN },
  { url: latinExt600, weight: '600', range: LATIN_EXT },
  { url: vietnamese600, weight: '600', range: VIETNAMESE },
  { url: latin700, weight: '700', range: LATIN },
  { url: latinExt700, weight: '700', range: LATIN_EXT },
  { url: vietnamese700, weight: '700', range: VIETNAMESE },
];

let loading: Promise<void> | undefined;

/**
 * Registers the bundled Inter faces and waits until they have loaded, so a canvas
 * draws text with them from the first frame. A face that fails to load never
 * blocks the caller; the renderer's font stack then falls back to Segoe UI.
 */
export function loadInter(): Promise<void> {
  loading ??= (async () => {
    const faces = FACES.map(({ url, weight, range }) => {
      const face = new FontFace('Inter', `url(${url}) format('woff2')`, {
        weight,
        style: 'normal',
        unicodeRange: range,
      });
      document.fonts.add(face);
      return face;
    });
    await Promise.allSettled(faces.map((face) => face.load()));
  })();
  return loading;
}
