//! Animated GIF writer: shared palette across the loop (`quantette`) and
//! frame encoding (`gif`). Not implemented yet.

/// Frame delay in GIF units (hundredths of a second) for a frame rate,
/// rounded to the nearest unit and never below 1.
pub fn frame_delay_centis(fps: u16) -> u16 {
    if fps == 0 {
        return 1;
    }
    let centis = (100 + fps / 2) / fps;
    centis.max(1)
}

#[cfg(test)]
mod tests {
    use super::frame_delay_centis;

    #[test]
    fn common_frame_rates() {
        assert_eq!(frame_delay_centis(10), 10);
        assert_eq!(frame_delay_centis(25), 4);
        assert_eq!(frame_delay_centis(30), 3);
        assert_eq!(frame_delay_centis(50), 2);
    }

    #[test]
    fn degenerate_rates_stay_positive() {
        assert_eq!(frame_delay_centis(0), 1);
        assert_eq!(frame_delay_centis(1000), 1);
    }
}
