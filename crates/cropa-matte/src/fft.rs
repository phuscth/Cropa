//! A small iterative radix-2 complex FFT on split real and imaginary
//! buffers, with a 2D transform built from it.

use std::f64::consts::PI;

/// Precomputed tables for transforms of one power-of-two length.
pub(crate) struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    reversed: Vec<u32>,
}

impl Fft {
    /// `n` must be a power of two.
    pub(crate) fn new(n: usize) -> Self {
        assert!(n.is_power_of_two(), "FFT length must be a power of two");
        let (cos, sin) = (0..n / 2)
            .map(|k| {
                let angle = 2.0 * PI * k as f64 / n as f64;
                (angle.cos() as f32, angle.sin() as f32)
            })
            .unzip();
        let bits = n.trailing_zeros();
        let mut reversed = vec![0u32; n];
        for i in 1..n {
            reversed[i] = (reversed[i >> 1] >> 1) | (((i & 1) as u32) << (bits - 1));
        }
        Self {
            n,
            cos,
            sin,
            reversed,
        }
    }

    /// In-place transform. The inverse divides by `n`, so a forward and
    /// an inverse transform restore the input.
    pub(crate) fn transform(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = self.n;
        debug_assert!(re.len() == n && im.len() == n);
        if n == 1 {
            return;
        }
        for i in 0..n {
            let j = self.reversed[i] as usize;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { 1.0 } else { -1.0 };
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], sign * self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len *= 2;
        }
        if inverse {
            let scale = 1.0 / n as f32;
            for v in re.iter_mut().chain(im.iter_mut()) {
                *v *= scale;
            }
        }
    }
}

/// 2D transform of a `width × height` row-major buffer (both lengths
/// powers of two): every row, then every column.
pub(crate) fn fft2d(re: &mut [f32], im: &mut [f32], width: usize, height: usize, inverse: bool) {
    let row_fft = Fft::new(width);
    for (r, i) in re.chunks_exact_mut(width).zip(im.chunks_exact_mut(width)) {
        row_fft.transform(r, i, inverse);
    }
    let column_fft = Fft::new(height);
    let mut column_re = vec![0.0f32; height];
    let mut column_im = vec![0.0f32; height];
    for x in 0..width {
        for y in 0..height {
            column_re[y] = re[y * width + x];
            column_im[y] = im[y * width + x];
        }
        column_fft.transform(&mut column_re, &mut column_im, inverse);
        for y in 0..height {
            re[y * width + x] = column_re[y];
            im[y * width + x] = column_im[y];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::Rng;

    #[test]
    fn transform_matches_the_direct_dft() {
        let n = 16;
        let mut rng = Rng::new(3);
        let re0: Vec<f32> = (0..n).map(|_| rng.unit()).collect();
        let im0: Vec<f32> = (0..n).map(|_| rng.unit()).collect();
        let (mut re, mut im) = (re0.clone(), im0.clone());
        Fft::new(n).transform(&mut re, &mut im, false);
        for k in 0..n {
            let (mut sr, mut si) = (0.0f64, 0.0f64);
            for t in 0..n {
                let angle = -2.0 * PI * (k * t) as f64 / n as f64;
                let (c, s) = (angle.cos(), angle.sin());
                sr += f64::from(re0[t]) * c - f64::from(im0[t]) * s;
                si += f64::from(re0[t]) * s + f64::from(im0[t]) * c;
            }
            assert!((f64::from(re[k]) - sr).abs() < 1e-4, "re[{k}]");
            assert!((f64::from(im[k]) - si).abs() < 1e-4, "im[{k}]");
        }
    }

    #[test]
    fn forward_then_inverse_2d_restores_the_input() {
        let (w, h) = (32, 16);
        let mut rng = Rng::new(4);
        let re0: Vec<f32> = (0..w * h).map(|_| rng.unit()).collect();
        let (mut re, mut im) = (re0.clone(), vec![0.0; w * h]);
        fft2d(&mut re, &mut im, w, h, false);
        fft2d(&mut re, &mut im, w, h, true);
        for (a, b) in re.iter().zip(&re0) {
            assert!((a - b).abs() < 1e-4);
        }
        assert!(im.iter().all(|v| v.abs() < 1e-4));
    }

    #[test]
    fn a_length_one_transform_is_a_no_op() {
        let (mut re, mut im) = ([2.0f32], [3.0f32]);
        Fft::new(1).transform(&mut re, &mut im, false);
        assert_eq!((re[0], im[0]), (2.0, 3.0));
    }
}
