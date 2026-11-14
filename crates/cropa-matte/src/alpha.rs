//! Reading the alpha out of the AI image and mapping it onto the
//! original's pixel grid.

use crate::Image;
use crate::plane::{Plane, box_downscale, pixels, resample};

/// Width of the frame, in pixels, sampled for the flat background colour.
const BORDER: usize = 4;
/// Fraction of pixels that must be translucent for the image's own alpha
/// to be trusted.
const MIN_TRANSLUCENT_FRACTION: f64 = 0.001;
/// Alpha values below this count as translucent.
const TRANSLUCENT_BELOW: u8 = 250;
/// The keying threshold never goes below this colour distance.
const MIN_KEY_THRESHOLD: f32 = 0.04;
/// Width of the ramp between transparent and opaque when keying.
const KEY_RAMP: f32 = 0.12;
/// Aspect ratios beyond 3:1 either way are clamped by the image tool.
const MAX_AI_ASPECT: f64 = 3.0;

/// The alpha of the AI image in 0..1, and whether it was keyed.
///
/// When the image carries real transparency (more than 0.1 % of its
/// pixels have alpha below 250) that alpha is used. Otherwise the image
/// is taken to have a flat background: its colour is the median of the
/// border, and each pixel's alpha grows with its colour distance from it.
pub(crate) fn ai_alpha(ai: Image) -> (Plane, bool) {
    let (width, height) = (ai.width as usize, ai.height as usize);
    let translucent = pixels(ai.rgba)
        .iter()
        .filter(|p| p[3] < TRANSLUCENT_BELOW)
        .count();
    if translucent as f64 > MIN_TRANSLUCENT_FRACTION * (width * height) as f64 {
        let data = pixels(ai.rgba)
            .iter()
            .map(|p| f32::from(p[3]) / 255.0)
            .collect();
        return (
            Plane {
                width,
                height,
                data,
            },
            false,
        );
    }
    (key_flat_background(ai), true)
}

fn key_flat_background(ai: Image) -> Plane {
    let (width, height) = (ai.width as usize, ai.height as usize);
    let border = border_pixels(width, height);
    let background = median_colour(ai, &border);

    let distance = |p: &[u8]| -> f32 {
        let d = |c: usize| (f32::from(p[c]) - background[c]) / 255.0;
        (d(0) * d(0) + d(1) * d(1) + d(2) * d(2)).sqrt()
    };
    let mut spread: Vec<f32> = border
        .iter()
        .map(|&i| distance(&ai.rgba[i * 4..i * 4 + 4]))
        .collect();
    spread.sort_unstable_by(f32::total_cmp);
    let p95 = spread[((spread.len() - 1) as f32 * 0.95).round() as usize];

    let t0 = MIN_KEY_THRESHOLD.max(1.5 * p95);
    let t1 = t0 + KEY_RAMP;
    let data = pixels(ai.rgba)
        .iter()
        .map(|p| ((distance(p) - t0) / (t1 - t0)).clamp(0.0, 1.0))
        .collect();
    Plane {
        width,
        height,
        data,
    }
}

/// Indices of the pixels within `BORDER` of an edge.
fn border_pixels(width: usize, height: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for y in 0..height {
        if y < BORDER || y + BORDER >= height {
            out.extend(y * width..(y + 1) * width);
        } else {
            out.extend(y * width..y * width + BORDER.min(width));
            out.extend((y * width + width.saturating_sub(BORDER).max(BORDER))..(y + 1) * width);
        }
    }
    out
}

fn median_colour(ai: Image, pixels: &[usize]) -> [f32; 3] {
    let mut out = [0.0; 3];
    for (c, slot) in out.iter_mut().enumerate() {
        let mut values: Vec<u8> = pixels.iter().map(|&i| ai.rgba[i * 4 + c]).collect();
        values.sort_unstable();
        *slot = f32::from(values[values.len() / 2]);
    }
    out
}

/// Maps a plane of the AI image onto a `width × height` grid, the size
/// of the original.
///
/// Normally the AI image is stretched to fit. When the original is more
/// than 3:1 either way the image tool clamped the aspect and padded the
/// short side with transparent margins, so the long sides are matched
/// instead and the short side is centre-cropped.
pub(crate) fn map_to(src: &Plane, width: usize, height: usize) -> Plane {
    let aspect = width as f64 / height as f64;
    let (mut scale_x, mut scale_y) = if (1.0 / MAX_AI_ASPECT..=MAX_AI_ASPECT).contains(&aspect) {
        (
            width as f64 / src.width as f64,
            height as f64 / src.height as f64,
        )
    } else {
        let s = if width >= height {
            width as f64 / src.width as f64
        } else {
            height as f64 / src.height as f64
        };
        (s, s)
    };

    // Bilinear sampling skips pixels when shrinking by more than 2x, so
    // average blocks first.
    let shrink = (1.0 / scale_x.max(scale_y)).floor();
    if shrink >= 2.0 {
        let reduced = box_downscale(src, shrink as usize);
        scale_x *= src.width as f64 / reduced.width as f64;
        scale_y *= src.height as f64 / reduced.height as f64;
        return resample(&reduced, width, height, scale_x, scale_y);
    }
    resample(src, width, height, scale_x, scale_y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::mask_plane;

    fn rgba(width: usize, height: usize, mut f: impl FnMut(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&f(x, y));
            }
        }
        out
    }

    fn image(width: usize, height: usize, rgba: &[u8]) -> Image<'_> {
        Image {
            width: width as u32,
            height: height as u32,
            rgba,
        }
    }

    #[test]
    fn real_alpha_is_used_as_it_is() {
        // Half transparent, half opaque, with different colours so a
        // keyer would see a subject on the right too.
        let px = rgba(40, 40, |x, _| {
            if x < 20 {
                [10, 10, 10, 0]
            } else {
                [200, 30, 30, 255]
            }
        });
        let (alpha, keyed) = ai_alpha(image(40, 40, &px));
        assert!(!keyed);
        assert_eq!(alpha.data[0], 0.0);
        assert_eq!(alpha.data[39], 1.0);
    }

    #[test]
    fn an_opaque_green_background_is_keyed_out() {
        let px = rgba(64, 64, |x, y| {
            if (20..44).contains(&x) && (20..44).contains(&y) {
                [200, 40, 40, 255]
            } else {
                [0, 255, 0, 255]
            }
        });
        let (alpha, keyed) = ai_alpha(image(64, 64, &px));
        assert!(keyed);
        assert_eq!(alpha.data[0], 0.0);
        assert_eq!(alpha.data[32 * 64 + 32], 1.0);
    }

    #[test]
    fn keying_tolerates_a_noisy_background() {
        // Background jitter of a few levels per channel must not leak
        // into the alpha; a subject far from it must stay solid.
        let mut seed = 7u32;
        let px = rgba(64, 64, |x, y| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let jitter = (seed >> 28) as u8; // 0..15
            if (20..44).contains(&x) && (20..44).contains(&y) {
                [30, 30, 200, 255]
            } else {
                [100 + jitter, 150 + jitter, 90 + jitter, 255]
            }
        });
        let (alpha, keyed) = ai_alpha(image(64, 64, &px));
        assert!(keyed);
        let background_leak = alpha.data[..64 * 10].iter().copied().fold(0.0, f32::max);
        assert_eq!(background_leak, 0.0);
        assert_eq!(alpha.data[32 * 64 + 32], 1.0);
    }

    #[test]
    fn a_stretch_keeps_a_rectangle_in_place() {
        // AI image at half size, same aspect: the rectangle scales up.
        let small = mask_plane(50, 40, |x, y| (10..20).contains(&x) && (5..15).contains(&y));
        let mapped = map_to(&small, 100, 80);
        assert_eq!(mapped.data[20 * 100 + 30], 1.0);
        assert_eq!(mapped.data[10 * 100 + 5], 0.0);
        assert_eq!(mapped.data[40 * 100 + 30], 0.0);
    }

    #[test]
    fn a_clamped_aspect_is_matched_on_the_long_side_and_cropped() {
        // The original is 4.3:1 (258 x 60). The image tool returned a
        // 3:1 canvas (258 x 86) with the picture in the middle rows
        // 13..73 and transparent margins above and below.
        let original = mask_plane(258, 60, |x, y| {
            (100..130).contains(&x) && (20..40).contains(&y)
        });
        let ai = mask_plane(258, 86, |x, y| {
            (100..130).contains(&x) && (33..53).contains(&y)
        });
        let mapped = map_to(&ai, 258, 60);
        let wrong = mapped
            .data
            .iter()
            .zip(&original.data)
            .filter(|(a, b)| (**a - **b).abs() > 0.5)
            .count();
        assert_eq!(wrong, 0);
    }

    #[test]
    fn a_clamped_aspect_works_when_the_ai_image_is_larger() {
        // Same layout at twice the size: 516 x 172 against 258 x 60.
        let original = mask_plane(258, 60, |x, y| {
            (100..130).contains(&x) && (20..40).contains(&y)
        });
        let ai = mask_plane(516, 172, |x, y| {
            (200..260).contains(&x) && (66..106).contains(&y)
        });
        let mapped = map_to(&ai, 258, 60);
        // Edge pixels may blend; every pixel that is clearly on or off
        // must agree and no more than a 1 px ring may differ at all.
        let disagreeing = mapped
            .data
            .iter()
            .zip(&original.data)
            .filter(|(a, b)| (**a - **b).abs() > 0.5)
            .count();
        assert!(disagreeing <= 2 * (30 + 20), "{disagreeing} pixels differ");
    }
}
