//! Deterministic synthetic inputs for the unit tests.

use crate::plane::Plane;

/// xorshift64*: small, seedable, no dependency.
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub(crate) fn next_u32(&mut self) -> u32 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32
    }

    pub(crate) fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
}

/// White noise in 0..1.
pub(crate) fn plane_noise(width: usize, height: usize, seed: u64) -> Plane {
    let mut rng = Rng::new(seed);
    Plane {
        width,
        height,
        data: (0..width * height).map(|_| rng.unit()).collect(),
    }
}

/// Opaque white-noise RGBA.
pub(crate) fn noise_rgba(width: usize, height: usize, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed);
    let mut out = Vec::with_capacity(width * height * 4);
    for _ in 0..width * height {
        let v = rng.next_u32();
        out.extend_from_slice(&[v as u8, (v >> 8) as u8, (v >> 16) as u8, 255]);
    }
    out
}

/// A plane that is 1 where `inside(x, y)` holds and 0 elsewhere.
pub(crate) fn mask_plane(
    width: usize,
    height: usize,
    inside: impl Fn(usize, usize) -> bool,
) -> Plane {
    let mut data = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            data.push(if inside(x, y) { 1.0 } else { 0.0 });
        }
    }
    Plane {
        width,
        height,
        data,
    }
}
