//! Checking that the AI image still lines up with the original.
//!
//! The comparison is a phase correlation of edge maps, restricted to the
//! area the AI image kept. It only measures: nothing is ever shifted to
//! make a mask fit.

use crate::fft::fft2d;
use crate::plane::{Plane, box_downscale};
use crate::{MatteError, Params};

/// The comparison runs on a grid of about this many pixels at most.
const GRID_PIXELS: f64 = 1_600_000.0;
/// Keeps the normalisation finite where the cross-power spectrum is empty.
const SPECTRUM_EPSILON: f32 = 1e-9;

/// Where the AI image sits relative to the original.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Alignment {
    /// Displacement of the AI image in original pixels: the AI's content
    /// at `p` is the original's content at `p - (dx, dy)`.
    pub(crate) dx: i32,
    pub(crate) dy: i32,
    /// Height of the correlation peak, 0..1. Near 1 for identical
    /// structure, near 0 for unrelated images.
    pub(crate) peak: f32,
}

/// Result of [`phase_correlate`], in the pixels of its inputs.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Shift {
    pub(crate) dx: f32,
    pub(crate) dy: f32,
    pub(crate) peak: f32,
}

/// Measures how far `moved` is displaced from `reference`: `moved(p)`
/// matches `reference(p - shift)`. Both planes have the same size and are
/// zero-padded to powers of two, so the shift is not periodic. The peak
/// position is refined to a fraction of a pixel by a parabola fit.
pub(crate) fn phase_correlate(reference: &Plane, moved: &Plane) -> Shift {
    debug_assert_eq!(
        (reference.width, reference.height),
        (moved.width, moved.height)
    );
    let pw = reference.width.next_power_of_two();
    let ph = reference.height.next_power_of_two();

    let (mut a_re, mut a_im) = padded(reference, pw, ph);
    let (mut b_re, mut b_im) = padded(moved, pw, ph);
    fft2d(&mut a_re, &mut a_im, pw, ph, false);
    fft2d(&mut b_re, &mut b_im, pw, ph, false);

    // cross = B * conj(A), scaled to unit magnitude; reuse A's buffers.
    for i in 0..pw * ph {
        let re = b_re[i] * a_re[i] + b_im[i] * a_im[i];
        let im = b_im[i] * a_re[i] - b_re[i] * a_im[i];
        let norm = re.hypot(im) + SPECTRUM_EPSILON;
        a_re[i] = re / norm;
        a_im[i] = im / norm;
    }
    drop((b_re, b_im));
    fft2d(&mut a_re, &mut a_im, pw, ph, true);
    let corr = a_re;

    let (peak_index, &peak) = corr
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .expect("the correlation is never empty");
    let (px, py) = (peak_index % pw, peak_index / pw);
    let at = |x: usize, y: usize| corr[y * pw + x];

    let fx = subpixel(at((px + pw - 1) % pw, py), peak, at((px + 1) % pw, py));
    let fy = subpixel(at(px, (py + ph - 1) % ph), peak, at(px, (py + 1) % ph));
    Shift {
        dx: signed(px, pw) as f32 + fx,
        dy: signed(py, ph) as f32 + fy,
        peak,
    }
}

fn padded(plane: &Plane, pw: usize, ph: usize) -> (Vec<f32>, Vec<f32>) {
    let mut re = vec![0.0f32; pw * ph];
    for (y, row) in plane.data.chunks_exact(plane.width).enumerate() {
        re[y * pw..y * pw + plane.width].copy_from_slice(row);
    }
    (re, vec![0.0f32; pw * ph])
}

/// Wraps a circular index to a signed displacement.
fn signed(index: usize, n: usize) -> isize {
    if index > n / 2 {
        index as isize - n as isize
    } else {
        index as isize
    }
}

/// Vertex of the parabola through three equally spaced samples, as an
/// offset from the middle one, limited to half a pixel.
fn subpixel(left: f32, middle: f32, right: f32) -> f32 {
    let curvature = left - 2.0 * middle + right;
    if curvature >= -1e-9 {
        return 0.0;
    }
    (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
}

/// Edge strength `|dx| + |dy|` from forward differences.
fn gradient_magnitude(plane: &Plane) -> Plane {
    let (w, h) = (plane.width, plane.height);
    let mut data = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let here = plane.data[y * w + x];
            let gx = if x + 1 < w {
                plane.data[y * w + x + 1] - here
            } else {
                0.0
            };
            let gy = if y + 1 < h {
                plane.data[(y + 1) * w + x] - here
            } else {
                0.0
            };
            data.push(gx.abs() + gy.abs());
        }
    }
    Plane {
        width: w,
        height: h,
        data,
    }
}

/// Compares the AI image's structure with the original's inside the area
/// the AI kept.
///
/// `original` and `ai` are grey planes (the same measure for both) and
/// `alpha` is the AI's alpha, all already mapped to one size. Edge maps
/// are weighted by the alpha before the correlation, so the mask's own
/// outline, which would agree with itself at any offset, is not what is
/// compared. Large inputs are reduced by a box filter to a grid of about
/// 1.6 MP; the offset is scaled back and rounded to original pixels.
///
/// Fails with [`MatteError::WeakAlignment`] when the peak is below
/// `params.min_peak`, and with [`MatteError::Misaligned`] when the offset
/// exceeds `params.max_offset_px` in either direction.
pub(crate) fn check_alignment(
    original: &Plane,
    ai: &Plane,
    alpha: &Plane,
    params: &Params,
) -> Result<Alignment, MatteError> {
    check_alignment_on_grid(original, ai, alpha, params, GRID_PIXELS)
}

fn check_alignment_on_grid(
    original: &Plane,
    ai: &Plane,
    alpha: &Plane,
    params: &Params,
    grid_pixels: f64,
) -> Result<Alignment, MatteError> {
    let pixels = (original.width * original.height) as f64;
    let factor = (pixels / grid_pixels).sqrt().ceil().max(1.0) as usize;

    let edges = |gray: &Plane| {
        let mut g = gradient_magnitude(&box_downscale(gray, factor));
        let weight = box_downscale(alpha, factor);
        for (v, w) in g.data.iter_mut().zip(&weight.data) {
            *v *= w;
        }
        g
    };
    let shift = phase_correlate(&edges(original), &edges(ai));

    let dx = (shift.dx * factor as f32).round() as i32;
    let dy = (shift.dy * factor as f32).round() as i32;
    if shift.peak < params.min_peak {
        return Err(MatteError::WeakAlignment);
    }
    if dx.abs().max(dy.abs()) as f32 > params.max_offset_px {
        return Err(MatteError::Misaligned { dx, dy });
    }
    Ok(Alignment {
        dx,
        dy,
        peak: shift.peak,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{mask_plane, plane_noise};

    /// `moved(p) = reference(p - (dx, dy))`, zero outside.
    fn shifted(reference: &Plane, dx: isize, dy: isize) -> Plane {
        let (w, h) = (reference.width as isize, reference.height as isize);
        let mut out = Plane::filled(reference.width, reference.height, 0.0);
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (x - dx, y - dy);
                if (0..w).contains(&sx) && (0..h).contains(&sy) {
                    out.data[(y * w + x) as usize] = reference.data[(sy * w + sx) as usize];
                }
            }
        }
        out
    }

    #[test]
    fn phase_correlation_finds_a_known_shift() {
        let reference = plane_noise(120, 100, 5);
        let moved = shifted(&reference, 3, -2);
        let s = phase_correlate(&reference, &moved);
        assert_eq!((s.dx.round() as i32, s.dy.round() as i32), (3, -2));
        assert!(s.peak > 0.5, "peak {}", s.peak);
    }

    #[test]
    fn phase_correlation_of_identical_images_is_zero_with_a_high_peak() {
        let reference = plane_noise(100, 100, 6);
        let s = phase_correlate(&reference, &reference.clone());
        assert_eq!((s.dx.round() as i32, s.dy.round() as i32), (0, 0));
        assert!(s.peak > Params::default().min_peak);
        assert!(s.peak > 0.9);
    }

    #[test]
    fn phase_correlation_of_unrelated_images_has_a_low_peak() {
        let s = phase_correlate(&plane_noise(100, 100, 7), &plane_noise(100, 100, 8));
        assert!(s.peak < 0.05, "peak {}", s.peak);
    }

    /// A noise picture with the AI's copy of it, moved by (dx, dy), and
    /// the AI's alpha over a central block that moves with it.
    fn scene(dx: isize, dy: isize) -> (Plane, Plane, Plane) {
        let original = plane_noise(160, 120, 9);
        let ai = shifted(&original, dx, dy);
        let block = |x: usize, y: usize| {
            let (x, y) = (x as isize - dx, y as isize - dy);
            (40..120).contains(&x) && (30..90).contains(&y)
        };
        (original, ai, mask_plane(160, 120, block))
    }

    #[test]
    fn an_aligned_ai_image_passes() {
        let (original, ai, alpha) = scene(0, 0);
        let a = check_alignment(&original, &ai, &alpha, &Params::default()).unwrap();
        assert_eq!((a.dx, a.dy), (0, 0));
        assert!(a.peak > Params::default().min_peak);
    }

    #[test]
    fn a_small_offset_within_the_limit_is_reported() {
        let (original, ai, alpha) = scene(2, -1);
        let a = check_alignment(&original, &ai, &alpha, &Params::default()).unwrap();
        assert_eq!((a.dx, a.dy), (2, -1));
    }

    #[test]
    fn four_pixels_of_offset_is_misaligned_even_when_the_mask_moved_too() {
        let (original, ai, alpha) = scene(4, 0);
        let err = check_alignment(&original, &ai, &alpha, &Params::default()).unwrap_err();
        assert_eq!(err, MatteError::Misaligned { dx: 4, dy: 0 });
    }

    #[test]
    fn unrelated_pictures_are_a_weak_alignment() {
        let original = plane_noise(160, 120, 10);
        let ai = plane_noise(160, 120, 11);
        let alpha = Plane::filled(160, 120, 1.0);
        let err = check_alignment(&original, &ai, &alpha, &Params::default()).unwrap_err();
        assert_eq!(err, MatteError::WeakAlignment);
    }

    #[test]
    fn grids_above_the_limit_are_reduced_and_the_offset_scaled_back() {
        // A 4 000 px grid reduces a 160 x 120 image by 3. Blocky noise
        // keeps its structure at the reduced scale, and a 3 px shift is
        // one grid pixel.
        let (w, h) = (160usize, 120usize);
        let base = plane_noise(w / 5, h / 5, 12);
        let mut original = Plane::filled(w, h, 0.0);
        for y in 0..h {
            for x in 0..w {
                original.data[y * w + x] = base.data[(y / 5) * base.width + x / 5];
            }
        }
        let ai = shifted(&original, 3, 0);
        let alpha = Plane::filled(w, h, 1.0);
        let params = Params {
            max_offset_px: 6.0,
            ..Params::default()
        };
        let a = check_alignment_on_grid(&original, &ai, &alpha, &params, 4_000.0).unwrap();
        assert_eq!((a.dx, a.dy), (3, 0));
    }
}
