//! Single-channel `f32` buffers and the filters the pipeline is built from.
//!
//! Every filter here is O(pixels): box filters run on sliding sums,
//! rank filters are separable and their window is a few pixels wide.

use crate::Image;

/// A single-channel image stored row by row.
#[derive(Clone, Debug)]
pub(crate) struct Plane {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) data: Vec<f32>,
}

impl Plane {
    #[cfg(test)]
    pub(crate) fn filled(width: usize, height: usize, value: f32) -> Self {
        Self {
            width,
            height,
            data: vec![value; width * height],
        }
    }

    /// Mean of all samples (0 for an empty plane).
    pub(crate) fn mean(&self) -> f32 {
        if self.data.is_empty() {
            return 0.0;
        }
        let sum: f64 = self.data.iter().map(|&v| f64::from(v)).sum();
        (sum / self.data.len() as f64) as f32
    }

    /// Sample at (x, y) with the coordinates clamped to the plane.
    pub(crate) fn at_clamped(&self, x: isize, y: isize) -> f32 {
        let x = x.clamp(0, self.width as isize - 1) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        self.data[y * self.width + x]
    }
}

/// The pixels of a straight RGBA buffer; trailing bytes that do not make
/// a whole pixel are ignored.
pub(crate) fn pixels(rgba: &[u8]) -> &[[u8; 4]] {
    rgba.as_chunks::<4>().0
}

pub(crate) fn pixels_mut(rgba: &mut [u8]) -> &mut [[u8; 4]] {
    rgba.as_chunks_mut::<4>().0
}

/// Mean of R, G and B in 0..1. Used where two images are compared and
/// only the structure matters.
pub(crate) fn mean_rgb(image: Image) -> Plane {
    let data = pixels(image.rgba)
        .iter()
        .map(|p| (f32::from(p[0]) + f32::from(p[1]) + f32::from(p[2])) / 765.0)
        .collect();
    Plane {
        width: image.width as usize,
        height: image.height as usize,
        data,
    }
}

/// Rec. 709 luminance in 0..1, the guide for refinement and edge tests.
pub(crate) fn luminance(image: Image) -> Plane {
    let data = pixels(image.rgba)
        .iter()
        .map(|p| {
            (0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])) / 255.0
        })
        .collect();
    Plane {
        width: image.width as usize,
        height: image.height as usize,
        data,
    }
}

/// Mean over the `(2r+1)²` window around every sample. Windows are
/// clipped at the borders and divided by the number of samples inside,
/// so a constant plane stays constant. Sums run in `f64`.
pub(crate) fn box_filter(src: &Plane, radius: usize) -> Plane {
    let (w, h) = (src.width, src.height);
    if w == 0 || h == 0 {
        return src.clone();
    }

    let mut horizontal = vec![0.0f32; w * h];
    for (row_in, row_out) in src.data.chunks_exact(w).zip(horizontal.chunks_exact_mut(w)) {
        box_row(row_in, row_out, radius);
    }

    let mut out = vec![0.0f32; w * h];
    let mut column_sum = vec![0.0f64; w];
    for y in 0..=radius.min(h - 1) {
        add_row(&mut column_sum, &horizontal[y * w..(y + 1) * w], 1.0);
    }
    for y in 0..h {
        if y > 0 {
            let entering = y + radius;
            if entering < h {
                add_row(
                    &mut column_sum,
                    &horizontal[entering * w..(entering + 1) * w],
                    1.0,
                );
            }
            if y > radius {
                let leaving = y - radius - 1;
                add_row(
                    &mut column_sum,
                    &horizontal[leaving * w..(leaving + 1) * w],
                    -1.0,
                );
            }
        }
        let count = ((y + radius).min(h - 1) - y.saturating_sub(radius) + 1) as f64;
        for (o, s) in out[y * w..(y + 1) * w].iter_mut().zip(&column_sum) {
            *o = (s / count) as f32;
        }
    }
    Plane {
        width: w,
        height: h,
        data: out,
    }
}

fn add_row(sum: &mut [f64], row: &[f32], sign: f64) {
    for (s, &v) in sum.iter_mut().zip(row) {
        *s += sign * f64::from(v);
    }
}

fn box_row(src: &[f32], dst: &mut [f32], radius: usize) {
    let n = src.len();
    let mut sum: f64 = src[..=radius.min(n - 1)]
        .iter()
        .map(|&v| f64::from(v))
        .sum();
    for x in 0..n {
        if x > 0 {
            if x + radius < n {
                sum += f64::from(src[x + radius]);
            }
            if x > radius {
                sum -= f64::from(src[x - radius - 1]);
            }
        }
        let count = ((x + radius).min(n - 1) - x.saturating_sub(radius) + 1) as f64;
        dst[x] = (sum / count) as f32;
    }
}

/// Averages `factor × factor` blocks. The last block of a row or column
/// averages the samples that exist.
pub(crate) fn box_downscale(src: &Plane, factor: usize) -> Plane {
    if factor <= 1 {
        return src.clone();
    }
    let out_w = src.width.div_ceil(factor);
    let out_h = src.height.div_ceil(factor);
    let mut data = Vec::with_capacity(out_w * out_h);
    for by in 0..out_h {
        let y_end = ((by + 1) * factor).min(src.height);
        for bx in 0..out_w {
            let x_end = ((bx + 1) * factor).min(src.width);
            let mut sum = 0.0f32;
            for y in by * factor..y_end {
                let row = &src.data[y * src.width..(y + 1) * src.width];
                sum += row[bx * factor..x_end].iter().sum::<f32>();
            }
            let count = ((y_end - by * factor) * (x_end - bx * factor)) as f32;
            data.push(sum / count);
        }
    }
    Plane {
        width: out_w,
        height: out_h,
        data,
    }
}

/// Bilinear resampling to `out_w × out_h`. `scale_x` and `scale_y` are
/// output pixels per source pixel; the centres of the two images
/// coincide, so a scale that makes the source larger than the output
/// crops it evenly on both sides, and a smaller one repeats the edge.
pub(crate) fn resample(
    src: &Plane,
    out_w: usize,
    out_h: usize,
    scale_x: f64,
    scale_y: f64,
) -> Plane {
    let xs = taps(out_w, src.width, scale_x);
    let ys = taps(out_h, src.height, scale_y);
    let mut data = Vec::with_capacity(out_w * out_h);
    for &(y0, y1, fy) in &ys {
        let row0 = &src.data[y0 * src.width..(y0 + 1) * src.width];
        let row1 = &src.data[y1 * src.width..(y1 + 1) * src.width];
        for &(x0, x1, fx) in &xs {
            let top = row0[x0] + (row0[x1] - row0[x0]) * fx;
            let bottom = row1[x0] + (row1[x1] - row1[x0]) * fx;
            data.push(top + (bottom - top) * fy);
        }
    }
    Plane {
        width: out_w,
        height: out_h,
        data,
    }
}

/// For each output index: the two source indices to blend and the
/// weight of the second.
fn taps(out_n: usize, src_n: usize, scale: f64) -> Vec<(usize, usize, f32)> {
    let last = src_n as isize - 1;
    (0..out_n)
        .map(|o| {
            let pos = (o as f64 + 0.5 - out_n as f64 / 2.0) / scale + src_n as f64 / 2.0 - 0.5;
            let base = pos.floor();
            let i0 = (base as isize).clamp(0, last) as usize;
            let i1 = (base as isize + 1).clamp(0, last) as usize;
            (i0, i1, (pos - base) as f32)
        })
        .collect()
}

/// Smallest value in the `(2r+1)²` window (borders repeat).
pub(crate) fn min_filter(src: &Plane, radius: usize) -> Plane {
    rank_filter(src, radius, f32::min)
}

/// Largest value in the `(2r+1)²` window (borders repeat).
pub(crate) fn max_filter(src: &Plane, radius: usize) -> Plane {
    rank_filter(src, radius, f32::max)
}

fn rank_filter(src: &Plane, radius: usize, pick: fn(f32, f32) -> f32) -> Plane {
    let (w, h) = (src.width, src.height);
    let r = radius as isize;
    let mut horizontal = src.clone();
    for y in 0..h {
        let row = &src.data[y * w..(y + 1) * w];
        for x in 0..w {
            let lo = (x as isize - r).max(0) as usize;
            let hi = ((x as isize + r) as usize).min(w - 1);
            horizontal.data[y * w + x] = row[lo..=hi].iter().copied().reduce(pick).unwrap_or(0.0);
        }
    }
    let mut out = horizontal.clone();
    for y in 0..h {
        let lo = (y as isize - r).max(0) as usize;
        let hi = ((y as isize + r) as usize).min(h - 1);
        for x in 0..w {
            out.data[y * w + x] = (lo..=hi)
                .map(|yy| horizontal.data[yy * w + x])
                .reduce(pick)
                .unwrap_or(0.0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::plane_noise;

    fn naive_box(src: &Plane, r: usize) -> Plane {
        let mut out = src.clone();
        for y in 0..src.height {
            for x in 0..src.width {
                let (mut sum, mut n) = (0.0f64, 0.0f64);
                for yy in y.saturating_sub(r)..=(y + r).min(src.height - 1) {
                    for xx in x.saturating_sub(r)..=(x + r).min(src.width - 1) {
                        sum += f64::from(src.data[yy * src.width + xx]);
                        n += 1.0;
                    }
                }
                out.data[y * src.width + x] = (sum / n) as f32;
            }
        }
        out
    }

    #[test]
    fn box_filter_matches_a_naive_window_mean() {
        let src = plane_noise(23, 17, 1);
        for r in [0, 1, 3, 30] {
            let fast = box_filter(&src, r);
            let slow = naive_box(&src, r);
            for (a, b) in fast.data.iter().zip(&slow.data) {
                assert!((a - b).abs() < 1e-5, "radius {r}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn box_filter_keeps_a_constant_plane_constant() {
        let out = box_filter(&Plane::filled(9, 7, 0.37), 4);
        assert!(out.data.iter().all(|&v| (v - 0.37).abs() < 1e-6));
    }

    #[test]
    fn box_downscale_averages_blocks_and_partial_edges() {
        let mut src = Plane::filled(5, 3, 0.0);
        src.data[0] = 4.0; // block (0, 0) of a 2x2 factor: mean 1
        src.data[4] = 6.0; // last column holds blocks of 1x2 samples: mean 3
        let out = box_downscale(&src, 2);
        assert_eq!((out.width, out.height), (3, 2));
        assert!((out.data[0] - 1.0).abs() < 1e-6);
        assert!((out.data[2] - 3.0).abs() < 1e-6);
    }

    #[test]
    fn resample_at_scale_one_is_the_identity() {
        let src = plane_noise(16, 11, 2);
        let out = resample(&src, 16, 11, 1.0, 1.0);
        assert_eq!(out.data, src.data);
    }

    #[test]
    fn resample_doubles_a_ramp_without_shifting_it() {
        let src = Plane {
            width: 4,
            height: 1,
            data: vec![0.0, 1.0, 2.0, 3.0],
        };
        let out = resample(&src, 8, 1, 2.0, 1.0);
        // Output sample centres fall at source positions -0.25, 0.25, ...
        let expected = [0.0, 0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.0];
        for (a, b) in out.data.iter().zip(expected) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
    }

    #[test]
    fn rank_filters_find_the_window_extremes() {
        let mut src = Plane::filled(9, 9, 0.0);
        src.data[4 * 9 + 4] = 1.0;
        let grown = max_filter(&src, 1);
        assert_eq!(grown.data.iter().filter(|&&v| v > 0.5).count(), 9);
        assert_eq!(min_filter(&grown, 1).data[4 * 9 + 4], 1.0);
        assert_eq!(min_filter(&src, 1).data.iter().sum::<f32>(), 0.0);
    }
}
