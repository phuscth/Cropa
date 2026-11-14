//! Turning the mapped AI alpha into a mask that follows the original's
//! edges: guided upsampling, an edge-aware choke, then thresholds and
//! an optional feather.

use crate::plane::{Plane, box_filter, max_filter, min_filter};

/// Luminance gradient (per pixel, 0..1) below which an edge counts as
/// soft and above which it counts as hard; the choke fades in between.
const HARD_EDGE_LOW: f32 = 0.15;
const HARD_EDGE_HIGH: f32 = 0.35;
/// A pixel is part of a thick area when this close to a pixel whose whole
/// 3x3 neighbourhood is inside the subject.
const THICK_REACH: usize = 2;
/// Radius of the window that supplies the local subject and background
/// luminance for the choke.
const COLOUR_REACH: usize = 3;
/// Fraction of that window that must be subject (or background).
const MIN_SHARE: f32 = 0.02;
/// Subject and background luminance closer than this give no estimate.
const MIN_CONTRAST: f32 = 0.05;
/// The alpha must exceed the luminance-based estimate by this much to
/// start counting as too wide, and by the second value to count fully.
const EXCESS_LOW: f32 = 0.3;
const EXCESS_HIGH: f32 = 0.7;

/// Regularisation of the guided filter, on luminance in 0..1.
pub(crate) const GUIDED_EPS: f32 = 1e-3;

/// Smallest ratio of original to AI long side at which guided upsampling
/// runs.
pub(crate) const MIN_GUIDED_UPSCALE: f64 = 1.25;

/// Window radius for guided upsampling when the original is `upscale`
/// times larger than the AI image (long side to long side).
///
/// An AI edge upsampled by `s` is about `2s` pixels wide, and the guided
/// filter only sharpens an edge its window can see across, so the radius
/// is twice the upscale factor, and at least 2.
pub(crate) fn guided_radius(upscale: f64) -> usize {
    ((2.0 * upscale).ceil() as usize).max(2)
}

/// Guided filter (He et al.) of `alpha` with `guide` as the guidance
/// image, both in 0..1 and of the same size.
///
/// Within each `(2r+1)²` window the output is a linear function of the
/// guide that best fits the alpha, so the alpha picks up the guide's
/// edges. `eps` limits how strongly a flat guide is trusted. Flat
/// regions of the alpha (all 0 or all 1) come out unchanged, and the
/// result is clamped to 0..1. Cost is O(pixels) whatever the radius.
pub(crate) fn guided_refine(alpha: &Plane, guide: &Plane, radius: usize, eps: f32) -> Plane {
    let mean_i = box_filter(guide, radius);
    let mean_p = box_filter(alpha, radius);

    let mut scratch = alpha.clone();
    for ((s, &i), &p) in scratch.data.iter_mut().zip(&guide.data).zip(&alpha.data) {
        *s = i * p;
    }
    let mut a = box_filter(&scratch, radius); // becomes the slope
    for (s, &i) in scratch.data.iter_mut().zip(&guide.data) {
        *s = i * i;
    }
    let mean_ii = box_filter(&scratch, radius);
    drop(scratch);

    let mut b = mean_p; // becomes the intercept
    for k in 0..a.data.len() {
        let (mi, mp) = (mean_i.data[k], b.data[k]);
        let covariance = a.data[k] - mi * mp;
        let variance = (mean_ii.data[k] - mi * mi).max(0.0);
        let slope = covariance / (variance + eps);
        a.data[k] = slope;
        b.data[k] = mp - slope * mi;
    }
    drop((mean_i, mean_ii));

    let mean_a = box_filter(&a, radius);
    let mean_b = box_filter(&b, radius);
    let mut out = mean_a;
    for ((o, &mb), &i) in out.data.iter_mut().zip(&mean_b.data).zip(&guide.data) {
        *o = (*o * i + mb).clamp(0.0, 1.0);
    }
    out
}

/// Pulls the alpha in by one pixel where the subject is thick, the
/// original has a hard edge and the pixel looks like background, and
/// nowhere else.
///
/// The image tool's alpha tends to be about a pixel too wide on photos
/// but is exact on flat interface graphics, so the edge itself decides:
/// the pixel's luminance is placed between the mean luminance of the
/// background and of the subject within `COLOUR_REACH` (a one-axis
/// estimate of how much subject the pixel really holds), and only a pixel
/// whose alpha clearly exceeds that estimate is choked. A thin structure
/// (hair, a whisker, a stem) has no pixel whose 3x3 neighbourhood lies
/// inside it, so it is never "thick" and is left alone; a soft edge in the
/// original (`guide`, luminance 0..1) is left alone too. The choked value
/// is the 3x3 minimum, blended in by thickness times edge hardness times
/// how background-like the pixel is.
pub(crate) fn choke_hard_edges(alpha: &Plane, guide: &Plane) -> Plane {
    let mut core = alpha.clone();
    for v in &mut core.data {
        *v = if *v > 0.5 { 1.0 } else { 0.0 };
    }
    let thick = max_filter(&min_filter(&core, 1), THICK_REACH);
    let eroded = min_filter(alpha, 1);
    let edges = sobel_magnitude(guide);
    let subject = masked_mean(guide, alpha, |a| a > 0.99);
    let background = masked_mean(guide, alpha, |a| a < 0.01);

    let mut out = alpha.clone();
    for k in 0..out.data.len() {
        let hard = thick.data[k] * smoothstep(HARD_EDGE_LOW, HARD_EDGE_HIGH, edges.data[k]);
        if hard == 0.0 {
            continue;
        }
        let (Some(f), Some(b)) = (subject[k], background[k]) else {
            continue;
        };
        let contrast = f - b;
        if contrast.abs() < MIN_CONTRAST {
            continue;
        }
        let share = ((guide.data[k] - b) / contrast).clamp(0.0, 1.0);
        let background_like = smoothstep(EXCESS_LOW, EXCESS_HIGH, alpha.data[k] - share);
        out.data[k] += (eroded.data[k] - alpha.data[k]) * hard * background_like;
    }
    out
}

/// Mean of `values` over the pixels within `COLOUR_REACH` where
/// `select(alpha)` holds; `None` where there are none.
fn masked_mean(values: &Plane, alpha: &Plane, select: fn(f32) -> bool) -> Vec<Option<f32>> {
    let mut mask = alpha.clone();
    let mut weighted = values.clone();
    for ((m, w), &a) in mask
        .data
        .iter_mut()
        .zip(&mut weighted.data)
        .zip(&alpha.data)
    {
        *m = if select(a) { 1.0 } else { 0.0 };
        *w *= *m;
    }
    let share = box_filter(&mask, COLOUR_REACH);
    let sum = box_filter(&weighted, COLOUR_REACH);
    share
        .data
        .iter()
        .zip(&sum.data)
        .map(|(&n, &s)| (n >= MIN_SHARE).then(|| s / n))
        .collect()
}

/// Sobel gradient magnitude scaled so that a step of height `h` reads
/// `h` next to it.
fn sobel_magnitude(plane: &Plane) -> Plane {
    let mut out = plane.clone();
    let (w, h) = (plane.width, plane.height);
    for y in 0..h {
        for x in 0..w {
            let at = |dx: isize, dy: isize| plane.at_clamped(x as isize + dx, y as isize + dy);
            let gx = (at(1, -1) + 2.0 * at(1, 0) + at(1, 1))
                - (at(-1, -1) + 2.0 * at(-1, 0) + at(-1, 1));
            let gy = (at(-1, 1) + 2.0 * at(0, 1) + at(1, 1))
                - (at(-1, -1) + 2.0 * at(0, -1) + at(1, -1));
            out.data[y * w + x] = gx.hypot(gy) / 4.0;
        }
    }
    out
}

fn smoothstep(low: f32, high: f32, x: f32) -> f32 {
    let t = ((x - low) / (high - low)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Snaps near-empty alpha to 0 and near-full alpha to 1 (`threshold` is
/// out of 255), then blurs by `feather` pixels when that is above 0.
///
/// The blur is three box passes, which approximates a Gaussian whose
/// standard deviation is `feather`.
pub(crate) fn snap_and_feather(alpha: &mut Plane, threshold: u8, feather: f32) {
    let low = f32::from(threshold) / 255.0;
    for v in &mut alpha.data {
        if *v < low {
            *v = 0.0;
        } else if *v > 1.0 - low {
            *v = 1.0;
        }
    }
    if feather > 0.0 {
        // Three box passes of width 2r+1 have variance 3((2r+1)²-1)/12.
        let radius = (((4.0 * feather * feather + 1.0).sqrt() - 1.0) / 2.0)
            .round()
            .max(1.0) as usize;
        for _ in 0..3 {
            *alpha = box_filter(alpha, radius);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plane::{box_downscale, resample};
    use crate::testutil::mask_plane;

    fn disc(size: usize, radius: f32) -> impl Fn(usize, usize) -> bool {
        let c = size as f32 / 2.0;
        move |x, y| {
            let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
            dx * dx + dy * dy <= radius * radius
        }
    }

    #[test]
    fn guided_upsampling_lands_closer_to_the_true_edge_than_bilinear() {
        let size = 128;
        let truth = mask_plane(size, size, disc(size, 40.0));
        // The guide is the original: bright disc on a dark ground.
        let mut guide = truth.clone();
        for v in &mut guide.data {
            *v = 0.1 + 0.8 * *v;
        }
        // The AI's alpha is half the resolution.
        let small = box_downscale(&truth, 2);
        let bilinear = resample(&small, size, size, 2.0, 2.0);
        let guided = guided_refine(&bilinear, &guide, guided_radius(2.0), GUIDED_EPS);

        // Edge band: pixels within 3 px of the true edge.
        let near_edge = |k: usize| {
            let (x, y) = ((k % size) as f32 + 0.5, (k / size) as f32 + 0.5);
            let d = ((x - 64.0).powi(2) + (y - 64.0).powi(2)).sqrt();
            (d - 40.0).abs() <= 3.0
        };
        let error = |p: &Plane| -> f32 {
            let (mut sum, mut n) = (0.0, 0);
            for k in (0..size * size).filter(|&k| near_edge(k)) {
                sum += (p.data[k] - truth.data[k]).abs();
                n += 1;
            }
            sum / n as f32
        };
        let (bilinear_error, guided_error) = (error(&bilinear), error(&guided));
        assert!(
            guided_error < 0.75 * bilinear_error,
            "guided {guided_error}, bilinear {bilinear_error}"
        );
    }

    #[test]
    fn guided_refinement_leaves_flat_regions_alone() {
        let size = 64;
        let alpha = mask_plane(size, size, |x, _| x >= 32);
        let guide = crate::testutil::plane_noise(size, size, 21);
        let out = guided_refine(&alpha, &guide, 3, 1e-3);
        // Far from the step, the whole window is flat.
        for y in 0..size {
            assert!(out.data[y * size + 5].abs() < 1e-3);
            assert!((out.data[y * size + 60] - 1.0).abs() < 1e-3);
        }
    }

    /// A black picture with white shapes, and the alpha that the AI
    /// would give: the same shapes with every edge 1 px too wide.
    struct Shapes {
        guide: Plane,
        alpha: Plane,
    }

    fn shapes() -> Shapes {
        let n = 100;
        let square = |x: usize, y: usize| (10..40).contains(&x) && (10..40).contains(&y);
        let line1 = |x: usize, y: usize| x == 60 && (10..90).contains(&y);
        let line2 = |x: usize, y: usize| (75..77).contains(&x) && (10..90).contains(&y);
        let truth = |x: usize, y: usize| square(x, y) || line1(x, y) || line2(x, y);
        let guide = mask_plane(n, n, truth);
        // Dilate the square by one pixel; the lines are already as wide
        // as the AI is trusted to draw them.
        let wide_square = |x: usize, y: usize| (9..41).contains(&x) && (9..41).contains(&y);
        let alpha = mask_plane(n, n, |x, y| wide_square(x, y) || line1(x, y) || line2(x, y));
        Shapes { guide, alpha }
    }

    #[test]
    fn choke_pulls_a_too_wide_solid_edge_in_by_a_pixel() {
        let s = shapes();
        let out = choke_hard_edges(&s.alpha, &s.guide);
        let at = |x: usize, y: usize| out.data[y * 100 + x];
        assert!(at(9, 25) < 0.05, "outer ring {}", at(9, 25));
        assert!(at(40, 25) < 0.05, "outer ring {}", at(40, 25));
        assert!(at(25, 9) < 0.05, "outer ring {}", at(25, 9));
        assert!(at(10, 25) > 0.99, "true edge {}", at(10, 25));
        assert!(at(25, 25) > 0.99);
    }

    #[test]
    fn choke_leaves_an_accurate_hard_edge_alone() {
        // Same picture, but the alpha is exactly as wide as the square:
        // pixels at its edge are subject-coloured, so nothing is choked.
        let s = shapes();
        let accurate = mask_plane(100, 100, |x, y| {
            (10..40).contains(&x) && (10..40).contains(&y)
        });
        let out = choke_hard_edges(&accurate, &s.guide);
        assert_eq!(out.data, accurate.data);
    }
    #[test]
    fn choke_leaves_thin_lines_alone() {
        let s = shapes();
        let out = choke_hard_edges(&s.alpha, &s.guide);
        for y in 20..80 {
            assert!(out.data[y * 100 + 60] > 0.99, "1 px line at row {y}");
            assert!(out.data[y * 100 + 75] > 0.99, "2 px line at row {y}");
            assert!(out.data[y * 100 + 76] > 0.99, "2 px line at row {y}");
        }
    }

    #[test]
    fn choke_leaves_soft_edges_alone() {
        // The same wide square, but the original is a smooth ramp.
        let n = 100;
        let alpha = mask_plane(n, n, |x, y| (9..41).contains(&x) && (9..41).contains(&y));
        let mut guide = Plane::filled(n, n, 0.0);
        for y in 0..n {
            for x in 0..n {
                guide.data[y * n + x] = x as f32 / n as f32 * 0.3;
            }
        }
        let out = choke_hard_edges(&alpha, &guide);
        assert_eq!(out.data, alpha.data);
    }

    #[test]
    fn threshold_snaps_near_empty_and_near_full_alpha() {
        let mut alpha = Plane {
            width: 5,
            height: 1,
            data: vec![0.02, 0.031, 0.5, 0.97, 0.99],
        };
        snap_and_feather(&mut alpha, 8, 0.0); // 8/255 = 0.0314
        assert_eq!(alpha.data, vec![0.0, 0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn feather_softens_a_hard_edge_and_keeps_solid_interiors() {
        let alpha = mask_plane(60, 8, |x, _| x >= 30);
        let mut hard = alpha.clone();
        snap_and_feather(&mut hard, 8, 0.0);
        assert_eq!(hard.data, alpha.data);

        let mut soft = alpha.clone();
        snap_and_feather(&mut soft, 8, 3.0);
        let row = &soft.data[..60];
        assert!(row[29] > 0.1 && row[29] < 0.5, "{}", row[29]);
        assert!(row[30] > 0.5 && row[30] < 0.9, "{}", row[30]);
        assert!(row[5] < 1e-3 && row[55] > 0.999);
        assert!(row.windows(2).all(|w| w[1] >= w[0] - 1e-6), "monotone");
    }
}
