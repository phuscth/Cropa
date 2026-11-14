//! Background cut-outs: turns the picture an image model made into a cut-out of the
//! editor's own pixels, and keeps it with the editor's image.
//!
//! The model's picture is untrusted input: it is checked (size, signature, pixel count)
//! before it is decoded, and only its alpha reaches the result (see `cropa_matte`).
//! Logs hold sizes, timing and the alignment measurements, never pixels.

use std::io::Cursor;
use std::time::Instant;

use base64::Engine;
use cropa_matte::{Image, MatteError, Params};
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits, RgbaImage};
use serde::Serialize;
use specta::Type;

use crate::editor::{Current, EditorImage};

/// The most bytes the model's PNG may have.
const MAX_AI_PNG_BYTES: usize = 32 * 1024 * 1024;
/// The most pixels the model's picture may have.
const MAX_AI_PIXELS: u64 = 16_000_000;
/// The most memory the decoder may allocate for the model's picture or the original.
const MAX_ALLOC: u64 = 512 * 1024 * 1024;
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Why no cut-out was made or kept. Serialised with `kind` and `detail`, like other errors.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Type)]
#[serde(tag = "kind", content = "detail")]
pub enum CutoutError {
    /// The editor's image was replaced; the result belongs to an image that is gone.
    #[error("the editor's image has changed")]
    ImageChanged,
    #[error("a picture could not be read: {0}")]
    Unreadable(String),
    #[error("a picture is too large to cut out")]
    TooLarge,
    #[error("the cut-out kept no subject")]
    NoSubject,
    #[error("the cut-out removed no background")]
    NoBackground,
    #[error("the cut-out is shifted by ({dx}, {dy}) px from the original")]
    Misaligned { dx: i32, dy: i32 },
    #[error("the cut-out shares too little with the original to line up")]
    WeakAlignment,
    /// The cut-out could not be finished (encoding, a worker that died); nothing was changed.
    #[error("could not finish the cut-out: {0}")]
    Failed(String),
    /// The history could not be updated to match what the editor shows.
    #[error("could not update the cut-out kept with the capture: {0}")]
    Save(String),
}

/// A decoder that stops on its size or memory limit says the picture is too large, not broken.
fn decode_error(err: &image::ImageError) -> CutoutError {
    match err {
        image::ImageError::Limits(_) => CutoutError::TooLarge,
        other => CutoutError::Unreadable(other.to_string()),
    }
}

impl From<MatteError> for CutoutError {
    fn from(err: MatteError) -> Self {
        match err {
            MatteError::NoSubject => Self::NoSubject,
            MatteError::NoBackground => Self::NoBackground,
            MatteError::Misaligned { dx, dy } => Self::Misaligned { dx, dy },
            MatteError::WeakAlignment => Self::WeakAlignment,
            MatteError::TooLarge => Self::TooLarge,
            MatteError::BadInput => Self::Unreadable("the pictures do not match".to_owned()),
        }
    }
}

/// The key the WebView holds for the image it is working on: the editor's generation.
pub fn parse_image_key(key: &str) -> Result<u64, CutoutError> {
    key.parse().map_err(|_| CutoutError::ImageChanged)
}

/// The editor's current image, when `key` still names it.
pub fn current_for(editor: &EditorImage, key: &str) -> Result<Current, CutoutError> {
    let generation = parse_image_key(key)?;
    editor
        .get()
        .filter(|current| current.generation == generation)
        .ok_or(CutoutError::ImageChanged)
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_ALLOC);
    limits
}

/// Check and decode the model's PNG, sent as base64 with no `data:` prefix.
fn decode_ai(data: &str) -> Result<RgbaImage, CutoutError> {
    if data.len() > MAX_AI_PNG_BYTES / 3 * 4 + 4 {
        return Err(CutoutError::TooLarge);
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|err| CutoutError::Unreadable(err.to_string()))?;
    if png.len() > MAX_AI_PNG_BYTES {
        return Err(CutoutError::TooLarge);
    }
    if !png.starts_with(&PNG_MAGIC) {
        return Err(CutoutError::Unreadable(
            "the PNG signature is missing".to_owned(),
        ));
    }
    let reader = || ImageReader::with_format(Cursor::new(&png), ImageFormat::Png);
    let (width, height) = reader()
        .into_dimensions()
        .map_err(|err| CutoutError::Unreadable(err.to_string()))?;
    if u64::from(width) * u64::from(height) > MAX_AI_PIXELS {
        return Err(CutoutError::TooLarge);
    }
    let mut reader = reader();
    reader.limits(limits());
    Ok(reader
        .decode()
        .map_err(|err| decode_error(&err))?
        .into_rgba8())
}

fn decode_original(png: &[u8]) -> Result<RgbaImage, CutoutError> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    reader.limits(limits());
    Ok(reader
        .decode()
        .map_err(|err| decode_error(&err))?
        .into_rgba8())
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, CutoutError> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|err| CutoutError::Failed(err.to_string()))?;
    Ok(bytes)
}

/// The cut-out of `original_png` that the model's picture (base64 PNG) describes, as PNG bytes.
pub fn make_cutout(original_png: &[u8], ai_base64: &str) -> Result<Vec<u8>, CutoutError> {
    let started = Instant::now();
    let ai = decode_ai(ai_base64)?;
    let original = decode_original(original_png)?;
    let matte = cropa_matte::cut_out(
        Image {
            width: original.width(),
            height: original.height(),
            rgba: original.as_raw(),
        },
        Image {
            width: ai.width(),
            height: ai.height(),
            rgba: ai.as_raw(),
        },
        &Params::default(),
    );
    let matte = match matte {
        Ok(matte) => matte,
        Err(err) => {
            log::info!(
                "cut-out refused after {} ms: {err}",
                started.elapsed().as_millis()
            );
            return Err(err.into());
        }
    };
    let cutout = RgbaImage::from_raw(matte.width, matte.height, matte.rgba)
        .ok_or_else(|| CutoutError::Failed("the cut-out buffer has the wrong size".to_owned()))?;
    let png = encode_png(&cutout)?;
    log::info!(
        "cut-out made in {} ms: {}x{} from a {}x{} picture, offset {:?}, peak {:.2}, coverage {:.2}, keyed {}",
        started.elapsed().as_millis(),
        original.width(),
        original.height(),
        ai.width(),
        ai.height(),
        matte.stats.offset,
        matte.stats.peak,
        matte.stats.coverage,
        matte.stats.keyed,
    );
    Ok(png)
}

/// The cut-out PNG named `name` of the editor's current image, or the error that tells the
/// caller why not.
pub fn named_cutout(current: &Current, name: &str) -> Result<std::sync::Arc<Vec<u8>>, CutoutError> {
    current
        .cutouts
        .get(name)
        .cloned()
        .ok_or_else(|| CutoutError::Unreadable("that cut-out is not kept".to_owned()))
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;

    fn png_of(image: &RgbaImage) -> Vec<u8> {
        encode_png(image).expect("the test image encodes")
    }

    fn base64_png(image: &RgbaImage) -> String {
        base64::engine::general_purpose::STANDARD.encode(png_of(image))
    }

    /// A busy square "subject" on a flat background, with hash noise so the alignment check
    /// has structure to measure.
    fn textured(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let inside = (width / 4..width * 3 / 4).contains(&x)
                && (height / 4..height * 3 / 4).contains(&y);
            if inside {
                let hash = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503).rotate_left(7);
                let v = u8::try_from((hash >> 8) % 200 + 30).unwrap();
                Rgba([v, v.wrapping_add(40), v.wrapping_sub(20), 255])
            } else {
                Rgba([240, 240, 240, 255])
            }
        })
    }

    fn with_subject_alpha(image: &RgbaImage) -> RgbaImage {
        let (width, height) = image.dimensions();
        RgbaImage::from_fn(width, height, |x, y| {
            let inside = (width / 4..width * 3 / 4).contains(&x)
                && (height / 4..height * 3 / 4).contains(&y);
            let Rgba([r, g, b, _]) = *image.get_pixel(x, y);
            Rgba([r, g, b, if inside { 255 } else { 0 }])
        })
    }

    #[test]
    fn the_subject_keeps_the_originals_pixels_and_the_background_goes() {
        let original = textured(160, 120);
        let ai = with_subject_alpha(&original);

        let png = make_cutout(&png_of(&original), &base64_png(&ai)).expect("a clean cut-out");

        let cutout = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(cutout.dimensions(), original.dimensions());
        assert_eq!(cutout.get_pixel(80, 60), original.get_pixel(80, 60));
        assert_eq!(cutout.get_pixel(2, 2)[3], 0);
    }

    #[test]
    fn what_the_matte_refuses_comes_back_as_its_own_kind() {
        let original = textured(160, 120);
        let nothing = RgbaImage::from_pixel(160, 120, Rgba([240, 240, 240, 0]));
        assert_eq!(
            make_cutout(&png_of(&original), &base64_png(&nothing)).unwrap_err(),
            CutoutError::NoSubject
        );
        // Real alpha that keeps all but 0.3 % of the picture: nothing was removed.
        let mut everything = original.clone();
        for x in 0..58 {
            everything.get_pixel_mut(x, 0)[3] = 0;
        }
        assert_eq!(
            make_cutout(&png_of(&original), &base64_png(&everything)).unwrap_err(),
            CutoutError::NoBackground
        );
    }

    #[test]
    fn a_decoder_limit_is_too_large_and_other_failures_are_unreadable() {
        use image::error::{LimitError, LimitErrorKind};
        let limit =
            image::ImageError::Limits(LimitError::from_kind(LimitErrorKind::InsufficientMemory));
        assert_eq!(decode_error(&limit), CutoutError::TooLarge);
        let broken = image::ImageError::IoError(std::io::Error::other("truncated"));
        assert!(matches!(decode_error(&broken), CutoutError::Unreadable(_)));
    }

    #[test]
    fn matte_errors_map_one_to_one() {
        assert_eq!(
            CutoutError::from(MatteError::Misaligned { dx: 3, dy: -1 }),
            CutoutError::Misaligned { dx: 3, dy: -1 }
        );
        assert_eq!(
            CutoutError::from(MatteError::WeakAlignment),
            CutoutError::WeakAlignment
        );
        assert_eq!(
            CutoutError::from(MatteError::TooLarge),
            CutoutError::TooLarge
        );
    }

    #[test]
    fn a_picture_that_is_not_a_usable_png_is_refused_before_decoding() {
        let original = png_of(&textured(40, 30));
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        for data in [
            encode(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0]),
            encode(&PNG_MAGIC),
            "***not base64***".to_owned(),
        ] {
            assert!(
                matches!(
                    make_cutout(&original, &data),
                    Err(CutoutError::Unreadable(_))
                ),
                "{data}"
            );
        }
    }

    #[test]
    fn a_picture_over_the_limits_is_too_large() {
        let wide = RgbaImage::new(4001, 4001);
        assert_eq!(
            make_cutout(&png_of(&textured(40, 30)), &base64_png(&wide)).unwrap_err(),
            CutoutError::TooLarge,
            "over 16 megapixels"
        );
        let huge = "A".repeat(MAX_AI_PNG_BYTES / 3 * 4 + 8);
        assert_eq!(
            make_cutout(&png_of(&textured(40, 30)), &huge).unwrap_err(),
            CutoutError::TooLarge,
            "over 32 MB"
        );
    }

    #[test]
    fn a_key_that_is_not_the_current_image_is_stale() {
        let editor = EditorImage::default();
        assert_eq!(
            current_for(&editor, "1").err(),
            Some(CutoutError::ImageChanged),
            "no image"
        );
        assert_eq!(
            current_for(&editor, "x").err(),
            Some(CutoutError::ImageChanged)
        );
        assert_eq!(
            parse_image_key("-1").unwrap_err(),
            CutoutError::ImageChanged
        );
        assert_eq!(parse_image_key("12").unwrap(), 12);
    }
}
