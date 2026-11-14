//! Building the cut-out from the original's pixels.

use crate::Image;
use crate::plane::{Plane, box_filter, pixels, pixels_mut};

/// Radius, in pixels, of the window that supplies the local background
/// and foreground colours.
const SAMPLE_RADIUS: usize = 6;
/// Fraction of the window that must be background (or foreground) for
/// its mean colour to count.
const MIN_SAMPLE_FRACTION: f32 = 1e-3;
/// Below this alpha the estimate leans on the nearby foreground colour,
/// because dividing by a tiny alpha amplifies noise.
const BLEND_BELOW: f32 = 0.25;

/// Rewrites the colour of every partially transparent pixel in `rgba`
/// (a copy of the original) to the colour the subject would have without
/// the background bleeding in.
///
/// A partial pixel is modelled as `I = α·F + (1 − α)·B`. `B` is the mean
/// of the original over the fully transparent pixels within
/// `SAMPLE_RADIUS`, and `F = (I − (1 − α)·B) / α` clamped to 0..255.
/// Below `BLEND_BELOW` the result moves toward the mean colour of the
/// fully opaque pixels nearby. Without any background sample nearby the
/// pixel is left as it is. Only the RGB bytes of partial pixels change.
pub(crate) fn decontaminate(original: Image, alpha: &Plane, rgba: &mut [u8]) {
    let is_partial = |a: f32| a > 0.0 && a < 1.0;
    if !alpha.data.iter().any(|&a| is_partial(a)) {
        return;
    }
    let indicator = |keep: fn(f32) -> bool| {
        let mut p = alpha.clone();
        for v in &mut p.data {
            *v = if keep(*v) { 1.0 } else { 0.0 };
        }
        p
    };
    let background = indicator(|a| a <= 0.0);
    let foreground = indicator(|a| a >= 1.0);
    let background_share = box_filter(&background, SAMPLE_RADIUS);
    let foreground_share = box_filter(&foreground, SAMPLE_RADIUS);

    // Colour channels are independent in this model, so one channel at a
    // time keeps the working set to a handful of planes.
    let mut channel = alpha.clone();
    for c in 0..3 {
        for (v, px) in channel.data.iter_mut().zip(pixels(original.rgba)) {
            *v = f32::from(px[c]);
        }
        let background_sum = masked_box(&channel, &background);
        let foreground_sum = masked_box(&channel, &foreground);

        for (k, &a) in alpha.data.iter().enumerate() {
            if !is_partial(a) || background_share.data[k] < MIN_SAMPLE_FRACTION {
                continue;
            }
            let b = background_sum.data[k] / background_share.data[k];
            let mut f = ((channel.data[k] - (1.0 - a) * b) / a).clamp(0.0, 255.0);
            if a < BLEND_BELOW && foreground_share.data[k] >= MIN_SAMPLE_FRACTION {
                let mean_f = foreground_sum.data[k] / foreground_share.data[k];
                f = mean_f + (f - mean_f) * (a / BLEND_BELOW);
            }
            rgba[k * 4 + c] = f.round() as u8;
        }
    }
}

/// Box mean of `values * mask`.
fn masked_box(values: &Plane, mask: &Plane) -> Plane {
    let mut product = values.clone();
    for (p, &m) in product.data.iter_mut().zip(&mask.data) {
        *p *= m;
    }
    box_filter(&product, SAMPLE_RADIUS)
}

/// The cut-out at the original's size, as straight RGBA.
///
/// - alpha 1: the original pixel, all four bytes unchanged;
/// - alpha 0: transparent black;
/// - otherwise: the decontaminated colour with alpha `round(α · A)`,
///   where `A` is the original pixel's own alpha. A pixel whose alpha
///   rounds back to `A` is the original pixel unchanged, and one that
///   rounds to 0 is transparent black.
pub(crate) fn composite(original: Image, alpha: &Plane) -> Vec<u8> {
    let mut out = original.rgba.to_vec();
    decontaminate(original, alpha, &mut out);
    for ((k, px), &a) in pixels_mut(&mut out).iter_mut().enumerate().zip(&alpha.data) {
        let source = &original.rgba[k * 4..k * 4 + 4];
        if a >= 1.0 {
            px.copy_from_slice(source);
        } else if a <= 0.0 {
            px.fill(0);
        } else {
            let new_alpha = (a * f32::from(source[3])).round() as u8;
            if new_alpha == 0 {
                px.fill(0);
            } else if new_alpha == source[3] {
                px.copy_from_slice(source);
            } else {
                px[3] = new_alpha;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: usize, height: usize, rgba: &[u8]) -> Image<'_> {
        Image {
            width: width as u32,
            height: height as u32,
            rgba,
        }
    }

    /// Green ground on the left, red subject on the right, and one
    /// column between them where the two mix 50/50.
    fn fringed() -> (Vec<u8>, Plane) {
        let (w, h) = (24, 8);
        let mut rgba = Vec::new();
        let mut alpha = Plane::filled(w, h, 0.0);
        for y in 0..h {
            for x in 0..w {
                let (px, a): ([u8; 4], f32) = match x {
                    0..=11 => ([0, 255, 0, 255], 0.0),
                    12 => ([128, 128, 0, 255], 0.5),
                    _ => ([255, 0, 0, 255], 1.0),
                };
                rgba.extend_from_slice(&px);
                alpha.data[y * w + x] = a;
            }
        }
        (rgba, alpha)
    }

    #[test]
    fn decontamination_removes_the_background_from_an_edge_pixel() {
        let (rgba, alpha) = fringed();
        let mut out = rgba.clone();
        decontaminate(image(24, 8, &rgba), &alpha, &mut out);
        let k = (3 * 24 + 12) * 4;
        assert!(out[k] >= 250, "red {}", out[k]);
        assert!(out[k + 1] <= 5, "green {}", out[k + 1]);
        // Nothing but the partial pixels changes.
        for (i, (a, b)) in out.iter().zip(&rgba).enumerate() {
            if i / 4 % 24 != 12 {
                assert_eq!(a, b);
            }
        }
    }

    #[test]
    fn a_very_transparent_pixel_leans_on_the_nearby_foreground() {
        let (mut rgba, mut alpha) = fringed();
        // Make the fringe 5 % opaque and exactly the colour of the ground:
        // the division alone would call the subject green here.
        for y in 0..8 {
            alpha.data[y * 24 + 12] = 0.05;
            rgba[(y * 24 + 12) * 4..(y * 24 + 12) * 4 + 3].copy_from_slice(&[0, 255, 0]);
        }
        let mut out = rgba.clone();
        decontaminate(image(24, 8, &rgba), &alpha, &mut out);
        let k = (3 * 24 + 12) * 4;
        assert!(out[k] > 150 && out[k + 1] < 100, "{:?}", &out[k..k + 3]);
    }

    #[test]
    fn a_pixel_with_no_background_nearby_keeps_its_colour() {
        let (w, h) = (30, 30);
        let rgba = vec![90u8; w * h * 4];
        let alpha = Plane::filled(w, h, 0.5);
        let mut out = rgba.clone();
        decontaminate(image(w, h, &rgba), &alpha, &mut out);
        assert_eq!(out, rgba);
    }

    #[test]
    fn composite_keeps_solid_pixels_and_clears_empty_ones() {
        let (rgba, alpha) = fringed();
        let out = composite(image(24, 8, &rgba), &alpha);
        let at = |x: usize, y: usize| &out[(y * 24 + x) * 4..(y * 24 + x) * 4 + 4];
        assert_eq!(at(20, 2), &[255, 0, 0, 255]);
        assert_eq!(at(2, 2), &[0, 0, 0, 0]);
        assert_eq!(at(12, 2)[3], 128); // round(0.5 * 255)
    }

    #[test]
    fn composite_scales_by_the_originals_own_alpha() {
        let rgba = [
            10u8, 20, 30, 100, 40, 50, 60, 100, 70, 80, 90, 100, 1, 2, 3, 100,
        ];
        let alpha = Plane {
            width: 4,
            height: 1,
            data: vec![1.0, 0.5, 0.0, 0.999],
        };
        let out = composite(image(4, 1, &rgba), &alpha);
        assert_eq!(&out[0..4], &[10, 20, 30, 100]); // solid: all four bytes
        assert_eq!(out[7], 50); // 0.5 * 100
        assert_eq!(&out[8..12], &[0, 0, 0, 0]);
        assert_eq!(&out[12..16], &[1, 2, 3, 100]); // rounds back to 100: untouched
    }
}
