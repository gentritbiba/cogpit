//! A session's replay buffer. Its limits count UTF-16 code units, the unit the
//! terminal panel has always measured them in, so trimming happens at the same
//! points it always did.

const MAX_UNITS: usize = 50_000;
const KEEP_UNITS: usize = 40_000;

#[derive(Default)]
pub struct Scrollback {
    text: String,
    units: usize,
}

impl Scrollback {
    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn push(&mut self, data: &str) {
        self.text.push_str(data);
        self.units += utf16_len(data);
        if self.units > MAX_UNITS {
            self.trim();
        }
    }

    /// Keeps the last 40 000 units, then drops the partial line they start with.
    fn trim(&mut self) {
        let drop_units = self.units - KEEP_UNITS;
        let start = if self.text.as_bytes()[..drop_units.min(self.text.len())].is_ascii() {
            drop_units
        } else {
            let mut drop_units = drop_units;
            let mut start = 0;
            for (index, ch) in self.text.char_indices() {
                if drop_units == 0 {
                    start = index;
                    break;
                }
                // A surrogate pair straddling the cut goes whole.
                drop_units = drop_units.saturating_sub(ch.len_utf16());
                start = index + ch.len_utf8();
            }
            start
        };
        let start = match self.text[start..].find('\n') {
            Some(newline) if newline > 0 => start + newline + 1,
            _ => start,
        };
        self.units -= utf16_len(&self.text[..start]);
        self.text.drain(..start);
    }
}

/// Every byte that starts a character is one unit; a four-byte character is two.
fn utf16_len(text: &str) -> usize {
    text.bytes()
        .map(|byte| usize::from(byte & 0xC0 != 0x80) + usize::from(byte >= 0xF0))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::Scrollback;

    #[test]
    fn keeps_everything_under_the_limit() {
        let mut scrollback = Scrollback::default();
        let chunk = "x".repeat(25_000);
        scrollback.push(&chunk);
        scrollback.push(&chunk);
        assert_eq!(scrollback.as_str().len(), 50_000);
    }

    #[test]
    fn trims_to_the_last_lines_once_over_the_limit() {
        let mut scrollback = Scrollback::default();
        let line = format!("{}\n", "a".repeat(99));
        for _ in 0..500 {
            scrollback.push(&line);
        }
        scrollback.push("tail");
        // 50 004 units: the last 40 000 start mid-line, so that line goes.
        let text = scrollback.as_str();
        assert!(text.ends_with("tail"));
        assert!(text.starts_with(&line));
        assert_eq!(text.len(), 399 * 100 + 4);
    }

    #[test]
    fn keeps_the_slice_when_it_starts_with_a_newline_or_has_none() {
        let mut scrollback = Scrollback::default();
        scrollback.push(&"z".repeat(50_001));
        assert_eq!(scrollback.as_str().len(), 40_000);

        let mut scrollback = Scrollback::default();
        scrollback.push(&"z".repeat(10_001));
        scrollback.push(&format!("\n{}", "y".repeat(39_999)));
        // 50 001 units; the kept 40 000 begin with the newline, which stays.
        assert_eq!(scrollback.as_str(), format!("\n{}", "y".repeat(39_999)));
    }

    #[test]
    fn counts_utf16_units_not_bytes() {
        let mut scrollback = Scrollback::default();
        // 25 000 emoji are 50 000 UTF-16 units and 100 000 bytes: at the limit, not over.
        scrollback.push(&"🎉".repeat(25_000));
        assert_eq!(scrollback.as_str().chars().count(), 25_000);
        scrollback.push("é");
        // 50 001 units: the last 40 000 begin with the second half of a pair,
        // which goes whole with its first half.
        assert_eq!(scrollback.as_str(), format!("{}é", "🎉".repeat(19_999)));
    }
}
