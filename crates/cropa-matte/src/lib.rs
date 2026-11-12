//! Background removal (ROADMAP D5): takes the cut-out Codex returns, keeps only
//! its alpha and applies it to the original pixels. Rewritten in Phase 5; the
//! v3 ONNX placeholder below is obsolete.

/// Longest side, in pixels, the model runs at. The mask is upscaled back to
/// the source resolution afterwards.
pub const INFERENCE_SIZE: u32 = 1024;

/// Size to resize `(width, height)` to so the longest side equals
/// [`INFERENCE_SIZE`], keeping the aspect ratio. Never returns 0.
pub fn inference_dims(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height).max(1);
    let scale = |side: u32| -> u32 {
        let scaled = u64::from(side) * u64::from(INFERENCE_SIZE) / u64::from(longest);
        u32::try_from(scaled).unwrap_or(INFERENCE_SIZE).max(1)
    };
    (scale(width), scale(height))
}

#[cfg(test)]
mod tests {
    use super::{INFERENCE_SIZE, inference_dims};

    #[test]
    fn landscape_keeps_aspect_ratio() {
        assert_eq!(inference_dims(1920, 1080), (INFERENCE_SIZE, 576));
    }

    #[test]
    fn portrait_keeps_aspect_ratio() {
        assert_eq!(inference_dims(1080, 1920), (576, INFERENCE_SIZE));
    }

    #[test]
    fn zero_sized_input_does_not_divide_by_zero() {
        assert_eq!(inference_dims(0, 0), (1, 1));
    }
}
