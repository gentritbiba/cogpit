//! Decodes a PTY's byte stream as UTF-8 across read boundaries.
//!
//! A read can end inside a multi-byte character. Those bytes wait for the next
//! read instead of turning into U+FFFD, the way `TextDecoder` with
//! `{ stream: true }` behaves. Invalid bytes become U+FFFD, one per maximal
//! invalid subpart, which is also what `TextDecoder` does.

const REPLACEMENT: &str = "\u{FFFD}";

#[derive(Default)]
pub struct StreamDecoder {
    pending: Vec<u8>,
}

impl StreamDecoder {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(invalid) => {
                            out.push_str(REPLACEMENT);
                            rest = &after[invalid..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// The stream ended: a character it cut short is replaced.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            REPLACEMENT.to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamDecoder;

    fn decode_in_chunks(bytes: &[u8], size: usize) -> String {
        let mut decoder = StreamDecoder::default();
        let mut out: String = bytes.chunks(size).map(|c| decoder.decode(c)).collect();
        out.push_str(&decoder.finish());
        out
    }

    #[test]
    fn keeps_multi_byte_characters_split_across_reads() {
        let text = "héllo → 世界 🎉 done";
        for size in 1..=text.len() {
            assert_eq!(
                decode_in_chunks(text.as_bytes(), size),
                text,
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn holds_an_incomplete_character_until_the_next_read() {
        let mut decoder = StreamDecoder::default();
        let emoji = "🎉".as_bytes();
        assert_eq!(decoder.decode(&emoji[..1]), "");
        assert_eq!(decoder.decode(&emoji[1..3]), "");
        assert_eq!(decoder.decode(&emoji[3..]), "🎉");
    }

    #[test]
    fn replaces_invalid_bytes_like_text_decoder() {
        let mut decoder = StreamDecoder::default();
        assert_eq!(decoder.decode(b"a\xffb"), "a\u{FFFD}b");
        // A lead byte followed by a non-continuation byte is one maximal subpart.
        assert_eq!(decoder.decode(b"\xe2\x82x"), "\u{FFFD}x");
        assert_eq!(decoder.decode(b"\xc0\xaf"), "\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn replaces_a_character_cut_off_by_the_end_of_the_stream() {
        let mut decoder = StreamDecoder::default();
        assert_eq!(
            decoder.decode("ok€".as_bytes().split_last().unwrap().1),
            "ok"
        );
        assert_eq!(decoder.finish(), "\u{FFFD}");
        assert_eq!(decoder.finish(), "");
    }
}
