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
    /// Appends `chunk`'s complete characters to `out`.
    pub fn decode(&mut self, chunk: &[u8], out: &mut String) {
        if self.pending.is_empty() {
            self.pending = decode_into(chunk, out).to_vec();
        } else {
            let mut bytes = std::mem::take(&mut self.pending);
            bytes.extend_from_slice(chunk);
            self.pending = decode_into(&bytes, out).to_vec();
        }
    }

    /// The stream ended: a character it cut short is replaced.
    pub fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            self.pending.clear();
            out.push_str(REPLACEMENT);
        }
    }
}

/// Appends `bytes` to `out` and returns the incomplete character it ends
/// with, if any.
fn decode_into<'a>(mut bytes: &'a [u8], out: &mut String) -> &'a [u8] {
    loop {
        match std::str::from_utf8(bytes) {
            Ok(valid) => {
                out.push_str(valid);
                return &[];
            }
            Err(error) => {
                let (valid, after) = bytes.split_at(error.valid_up_to());
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    Some(invalid) => {
                        out.push_str(REPLACEMENT);
                        bytes = &after[invalid..];
                    }
                    None => return after,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamDecoder;

    fn decode_in_chunks(bytes: &[u8], size: usize) -> String {
        let mut decoder = StreamDecoder::default();
        let mut out = String::new();
        for chunk in bytes.chunks(size) {
            decoder.decode(chunk, &mut out);
        }
        decoder.finish(&mut out);
        out
    }

    fn decode(decoder: &mut StreamDecoder, chunk: &[u8]) -> String {
        let mut out = String::new();
        decoder.decode(chunk, &mut out);
        out
    }

    fn finish(decoder: &mut StreamDecoder) -> String {
        let mut out = String::new();
        decoder.finish(&mut out);
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
        assert_eq!(decode(&mut decoder, &emoji[..1]), "");
        assert_eq!(decode(&mut decoder, &emoji[1..3]), "");
        assert_eq!(decode(&mut decoder, &emoji[3..]), "🎉");
    }

    #[test]
    fn replaces_invalid_bytes_like_text_decoder() {
        let mut decoder = StreamDecoder::default();
        assert_eq!(decode(&mut decoder, b"a\xffb"), "a\u{FFFD}b");
        // A lead byte followed by a non-continuation byte is one maximal subpart.
        assert_eq!(decode(&mut decoder, b"\xe2\x82x"), "\u{FFFD}x");
        assert_eq!(decode(&mut decoder, b"\xc0\xaf"), "\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn replaces_a_character_cut_off_by_the_end_of_the_stream() {
        let mut decoder = StreamDecoder::default();
        assert_eq!(
            decode(&mut decoder, "ok€".as_bytes().split_last().unwrap().1),
            "ok"
        );
        assert_eq!(finish(&mut decoder), "\u{FFFD}");
        assert_eq!(finish(&mut decoder), "");
    }
}
