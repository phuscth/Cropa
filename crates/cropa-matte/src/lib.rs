//! Background removal from a cut-out made by an image model.
//!
//! The model's picture is not trusted for its colours or its geometry:
//! only its alpha is kept. [`cut_out`] maps that alpha onto the original
//! screenshot, checks that the model did not move the picture, refines
//! the alpha against the original's own edges and returns a cut-out made
//! of the original's pixels. Only partially transparent edge pixels get a
//! new colour, with the background that bled into them taken out.
//!
//! The pipeline, each step a function of its own:
//!
//! 1. `alpha::ai_alpha`: the AI image's alpha, keyed from a flat
//!    background when the image has none.
//! 2. `alpha::map_to`: the alpha stretched (or cover-fitted for aspect
//!    ratios beyond 3:1) to the original's size.
//! 3. a subject check on the mapped alpha.
//! 4. `align::check_alignment`: masked phase correlation of the AI colour
//!    against the original. The mask is never shifted to fit.
//! 5. `refine::guided_refine`: guided upsampling against the original's
//!    luminance, only when the AI image has fewer pixels than the original.
//! 6. `refine::choke_hard_edges`: a one pixel choke only on thick
//!    subjects, at hard edges, where the pixel looks like background.
//! 7. `refine::snap_and_feather`: thresholds and an optional feather.
//! 8. `composite::decontaminate` and `composite::composite`: colours.
//!
//! It works on plain buffers, with no dependencies.

// Pixel coordinates, counts and 8-bit samples move between integer and
// floating point types throughout; every such cast is on values bounded
// by the size limits checked in `cut_out`.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::similar_names
)]

mod align;
mod alpha;
mod composite;
mod fft;
mod plane;
mod refine;
#[cfg(test)]
mod testutil;

use std::fmt;

/// A borrowed image: straight (non-premultiplied) RGBA, 8 bits per
/// channel, rows top to bottom with no padding.
#[derive(Clone, Copy, Debug)]
pub struct Image<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
}

/// Tunables for [`cut_out`]. The defaults are what the app uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    /// Blur applied to the final alpha, in pixels. 0 keeps the edge as
    /// sharp as the refinement left it.
    pub feather: f32,
    /// Alpha below `threshold / 255` becomes 0 and above
    /// `1 - threshold / 255` becomes 1, so solid areas are exactly opaque.
    pub threshold: u8,
    /// Largest displacement, in original pixels, between the AI image
    /// and the original that is still accepted.
    pub max_offset_px: f32,
    /// Smallest correlation peak (0..1) that counts as a reliable
    /// alignment measurement.
    pub min_peak: f32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            feather: 0.0,
            threshold: 8,
            max_offset_px: 2.0,
            min_peak: 0.08,
        }
    }
}

/// What [`cut_out`] measured on the way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stats {
    /// The AI image had no real alpha and its background was keyed out.
    pub keyed: bool,
    /// How far the AI image was displaced from the original, in original
    /// pixels (within `Params::max_offset_px` or the call fails).
    pub offset: (i32, i32),
    /// Height of the alignment correlation peak, 0..1.
    pub peak: f32,
    /// Mean of the final alpha, 0..1: the share of the picture kept.
    pub coverage: f32,
}

/// The finished cut-out: the original's size, straight RGBA.
#[derive(Clone, Debug)]
pub struct Matte {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub stats: Stats,
}

/// Why no cut-out was produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatteError {
    /// The AI image kept (almost) nothing.
    NoSubject,
    /// The AI image removed (almost) nothing.
    NoBackground,
    /// The AI image is displaced from the original by more than the
    /// allowed offset, in original pixels.
    Misaligned { dx: i32, dy: i32 },
    /// The two images share too little structure to measure an offset.
    WeakAlignment,
    /// The original is over 25 MP or the AI image over 16 MP.
    TooLarge,
    /// A zero size, or a buffer whose length is not `width * height * 4`.
    BadInput,
}

impl fmt::Display for MatteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSubject => f.write_str("the cut-out kept no subject"),
            Self::NoBackground => f.write_str("the cut-out removed no background"),
            Self::Misaligned { dx, dy } => {
                write!(
                    f,
                    "the cut-out is shifted by ({dx}, {dy}) px from the original"
                )
            }
            Self::WeakAlignment => f.write_str("the cut-out cannot be matched to the original"),
            Self::TooLarge => f.write_str("an image is too large"),
            Self::BadInput => f.write_str("an image has a zero size or a wrong buffer length"),
        }
    }
}

impl std::error::Error for MatteError {}

const MAX_ORIGINAL_PIXELS: u64 = 25_000_000;
const MAX_AI_PIXELS: u64 = 16_000_000;
/// Mean alpha of the mapped AI image outside which it holds no usable
/// subject: below 0.2 % nothing was kept, above 99.5 % nothing removed.
const MIN_COVERAGE: f32 = 0.002;
const MAX_COVERAGE: f32 = 0.995;

/// Applies the alpha of `ai` to `original`.
///
/// `ai` is the model's cut-out of `original`, at any size; only its alpha
/// (or, with no alpha, its keyed flat background) is used. The result has
/// the original's size. Every pixel of full alpha is the original pixel,
/// byte for byte; see the module documentation for the steps.
pub fn cut_out(original: Image, ai: Image, params: &Params) -> Result<Matte, MatteError> {
    validate(original, ai)?;
    let (w, h) = (original.width as usize, original.height as usize);

    let (ai_alpha, keyed) = alpha::ai_alpha(ai);
    let mapped = alpha::map_to(&ai_alpha, w, h);
    drop(ai_alpha);

    check_subject(&mapped)?;

    let alignment = {
        let original_gray = plane::mean_rgb(original);
        let ai_gray = alpha::map_to(&plane::mean_rgb(ai), w, h);
        align::check_alignment(&original_gray, &ai_gray, &mapped, params)?
    };

    let guide = plane::luminance(original);
    let upscale =
        f64::from(original.width.max(original.height)) / f64::from(ai.width.max(ai.height));
    // Guided upsampling only helps when the AI image has fewer pixels than
    // the original: otherwise the mapped alpha is already at or above the
    // original's resolution and the filter would only soften it.
    let refined = if upscale >= refine::MIN_GUIDED_UPSCALE {
        refine::guided_refine(
            &mapped,
            &guide,
            refine::guided_radius(upscale),
            refine::GUIDED_EPS,
        )
    } else {
        mapped
    };
    let mut final_alpha = refine::choke_hard_edges(&refined, &guide);
    drop((refined, guide));
    refine::snap_and_feather(&mut final_alpha, params.threshold, params.feather);

    let rgba = composite::composite(original, &final_alpha);
    Ok(Matte {
        width: original.width,
        height: original.height,
        rgba,
        stats: Stats {
            keyed,
            offset: (alignment.dx, alignment.dy),
            peak: alignment.peak,
            coverage: final_alpha.mean(),
        },
    })
}

/// Sizes first, so an oversized image is refused without its buffer
/// being read, then buffer lengths.
fn validate(original: Image, ai: Image) -> Result<(), MatteError> {
    let pixels = |i: Image| u64::from(i.width) * u64::from(i.height);
    if pixels(original) == 0 || pixels(ai) == 0 {
        return Err(MatteError::BadInput);
    }
    if pixels(original) > MAX_ORIGINAL_PIXELS || pixels(ai) > MAX_AI_PIXELS {
        return Err(MatteError::TooLarge);
    }
    if original.rgba.len() as u64 != pixels(original) * 4 || ai.rgba.len() as u64 != pixels(ai) * 4
    {
        return Err(MatteError::BadInput);
    }
    Ok(())
}

/// Rejects a mapped alpha that kept next to nothing or removed next to
/// nothing.
fn check_subject(mapped: &plane::Plane) -> Result<(), MatteError> {
    let coverage = mapped.mean();
    if coverage < MIN_COVERAGE {
        Err(MatteError::NoSubject)
    } else if coverage > MAX_COVERAGE {
        Err(MatteError::NoBackground)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::noise_rgba;

    const W: usize = 128;
    const H: usize = 96;

    fn image(width: usize, height: usize, rgba: &[u8]) -> Image<'_> {
        Image {
            width: width as u32,
            height: height as u32,
            rgba,
        }
    }

    fn in_disc(x: usize, y: usize) -> bool {
        let (dx, dy) = (x as f32 - 64.0, y as f32 - 48.0);
        dx * dx + dy * dy <= 30.0 * 30.0
    }

    /// What the model returns: the original's picture, with everything
    /// outside the disc transparent, displaced by `dx` pixels.
    fn ai_of(original: &[u8], dx: usize) -> Vec<u8> {
        let mut out = vec![0u8; W * H * 4];
        for y in 0..H {
            for x in dx..W {
                if in_disc(x - dx, y) {
                    let (s, d) = ((y * W + x - dx) * 4, (y * W + x) * 4);
                    out[d..d + 4].copy_from_slice(&original[s..s + 4]);
                }
            }
        }
        out
    }

    #[test]
    fn solid_pixels_equal_the_original_bit_for_bit() {
        let original = noise_rgba(W, H, 31);
        let ai = ai_of(&original, 0);
        let matte = cut_out(image(W, H, &original), image(W, H, &ai), &Params::default()).unwrap();

        assert_eq!((matte.width, matte.height), (W as u32, H as u32));
        let mut solid = 0;
        let mut empty = 0;
        for k in 0..W * H {
            let out = &matte.rgba[k * 4..k * 4 + 4];
            if out[3] == 255 {
                assert_eq!(out, &original[k * 4..k * 4 + 4], "pixel {k}");
                solid += 1;
            }
            if out[3] == 0 {
                assert_eq!(out, &[0, 0, 0, 0]);
                empty += 1;
            }
        }
        assert!(solid > 2000, "{solid} solid pixels");
        assert!(empty > 5000, "{empty} empty pixels");
        assert!(!matte.stats.keyed);
        assert_eq!(matte.stats.offset, (0, 0));
        assert!(matte.stats.peak > Params::default().min_peak);
        assert!((0.15..0.35).contains(&matte.stats.coverage));
    }

    #[test]
    fn a_keyed_background_gives_the_same_kind_of_result() {
        let original = noise_rgba(W, H, 32);
        // Opaque AI image: the disc keeps the picture, the rest is flat green.
        let mut ai = vec![0u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let k = (y * W + x) * 4;
                if in_disc(x, y) {
                    ai[k..k + 4].copy_from_slice(&original[k..k + 4]);
                } else {
                    ai[k..k + 4].copy_from_slice(&[0, 255, 0, 255]);
                }
            }
        }
        let matte = cut_out(image(W, H, &original), image(W, H, &ai), &Params::default());
        let matte = matte.unwrap();
        assert!(matte.stats.keyed);
        assert!((0.15..0.35).contains(&matte.stats.coverage));
    }

    #[test]
    fn the_originals_own_alpha_is_kept_on_solid_pixels() {
        let mut original = noise_rgba(W, H, 33);
        for px in plane::pixels_mut(&mut original) {
            px[3] = 180;
        }
        let mut ai = ai_of(&original, 0);
        for px in plane::pixels_mut(&mut ai).iter_mut().filter(|p| p[3] != 0) {
            px[3] = 255;
        }
        let matte = cut_out(image(W, H, &original), image(W, H, &ai), &Params::default()).unwrap();
        let k = (48 * W + 64) * 4;
        assert_eq!(&matte.rgba[k..k + 4], &original[k..k + 4]);
        assert_eq!(matte.rgba[3], 0);
    }

    #[test]
    fn a_shifted_ai_image_is_misaligned() {
        let original = noise_rgba(W, H, 34);
        let ai = ai_of(&original, 5);
        let err =
            cut_out(image(W, H, &original), image(W, H, &ai), &Params::default()).unwrap_err();
        assert_eq!(err, MatteError::Misaligned { dx: 5, dy: 0 });
    }

    #[test]
    fn an_empty_cut_out_has_no_subject() {
        let original = noise_rgba(W, H, 35);
        let ai = vec![0u8; W * H * 4];
        let err =
            cut_out(image(W, H, &original), image(W, H, &ai), &Params::default()).unwrap_err();
        assert_eq!(err, MatteError::NoSubject);
    }

    #[test]
    fn an_untouched_picture_has_no_background_removed() {
        let original = noise_rgba(W, H, 36);
        // Real alpha, but only 0.24 % of the pixels transparent.
        let mut ai = original.clone();
        for px in plane::pixels_mut(&mut ai).iter_mut().take(30) {
            px[3] = 0;
        }
        let err =
            cut_out(image(W, H, &original), image(W, H, &ai), &Params::default()).unwrap_err();
        assert_eq!(err, MatteError::NoBackground);
    }

    #[test]
    fn oversized_and_malformed_inputs_are_refused_before_any_work() {
        let small = noise_rgba(8, 8, 37);
        let p = Params::default();
        // The slices are far too short: sizes are checked first.
        let huge = Image {
            width: 6000,
            height: 5000,
            rgba: &[],
        };
        assert_eq!(
            cut_out(huge, image(8, 8, &small), &p).unwrap_err(),
            MatteError::TooLarge
        );
        let big_ai = Image {
            width: 4001,
            height: 4000,
            rgba: &[],
        };
        assert_eq!(
            cut_out(image(8, 8, &small), big_ai, &p).unwrap_err(),
            MatteError::TooLarge
        );

        assert_eq!(
            cut_out(image(8, 8, &small[..100]), image(8, 8, &small), &p).unwrap_err(),
            MatteError::BadInput
        );
        assert_eq!(
            cut_out(image(0, 8, &[]), image(8, 8, &small), &p).unwrap_err(),
            MatteError::BadInput
        );
    }

    #[test]
    fn a_cut_out_at_another_size_is_mapped_to_the_original() {
        // The AI image is half the size of the original.
        let (aw, ah) = (W / 2, H / 2);
        // Noise in 4x4 blocks keeps its structure at half size.
        let blocks = noise_rgba(W / 4, H / 4, 38);
        let mut original = vec![0u8; W * H * 4];
        for y in 0..H {
            for x in 0..W {
                let (s, d) = (((y / 4) * (W / 4) + x / 4) * 4, (y * W + x) * 4);
                original[d..d + 4].copy_from_slice(&blocks[s..s + 4]);
            }
        }
        let mut ai = vec![0u8; aw * ah * 4];
        for y in 0..ah {
            for x in 0..aw {
                let k = (y * aw + x) * 4;
                if in_disc(x * 2, y * 2) {
                    let s = ((y * 2) * W + x * 2) * 4;
                    ai[k..k + 4].copy_from_slice(&original[s..s + 4]);
                }
            }
        }
        let matte = cut_out(
            image(W, H, &original),
            image(aw, ah, &ai),
            &Params::default(),
        )
        .unwrap();
        assert_eq!((matte.width, matte.height), (W as u32, H as u32));
        assert_eq!(matte.stats.offset, (0, 0));
        let k = (48 * W + 64) * 4;
        assert_eq!(&matte.rgba[k..k + 4], &original[k..k + 4]);
        assert_eq!(&matte.rgba[0..4], &[0, 0, 0, 0]);
    }
}
