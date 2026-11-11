//! Response and request helpers shared by the routes, matching the TypeScript
//! server's `sendJson` and `URLSearchParams` behaviour.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Serialize, Serializer};

/// A JSON response with exactly `Content-Type: application/json`.
pub fn json(status: StatusCode, body: &impl Serialize) -> Response {
    let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let mut response = (status, bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

/// A route failure: the status and the `error` message it responds with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure(pub u16, pub &'static str);

impl Failure {
    pub fn respond(self) -> Response {
        error(self.0, self.1)
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

/// `{ "error": message }` with the given status.
pub fn error(status: u16, message: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    json(status, &ErrorBody { error: message })
}

/// A number serialized the way `JSON.stringify` writes it: integral values
/// carry no `.0`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            #[allow(clippy::cast_possible_truncation)]
            return serializer.serialize_i64(value as i64);
        }
        serializer.serialize_f64(value)
    }
}

/// The first value of `name` in the query string, decoded like
/// `URLSearchParams.get` (`+` is a space, bad escapes pass through).
pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// Characters `String.prototype.trim` and `/\s/` treat as whitespace.
pub fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

/// `Number(text)` for a query parameter: `NaN` when JavaScript would give it.
pub fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = match trimmed.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &trimmed[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |total, c| {
            total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        });
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        return f64::NAN;
    }
    trimmed.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers_serialize_without_a_trailing_fraction() {
        assert_eq!(
            serde_json::to_string(&JsNumber(1_731_412_345_678.0)).unwrap(),
            "1731412345678"
        );
        assert_eq!(
            serde_json::to_string(&JsNumber(1_731_412_345_678.123_5)).unwrap(),
            "1731412345678.1235"
        );
        assert_eq!(serde_json::to_string(&JsNumber(0.5)).unwrap(), "0.5");
    }

    #[test]
    fn query_params_decode_like_url_search_params() {
        assert_eq!(
            query_param(Some("path=%2Ftmp%2Fa+b.png"), "path").as_deref(),
            Some("/tmp/a b.png")
        );
        assert_eq!(query_param(Some("a=1&a=2"), "a").as_deref(), Some("1"));
        assert_eq!(query_param(Some("a=1"), "b"), None);
        assert_eq!(query_param(None, "b"), None);
        assert_eq!(query_param(Some("p="), "p").as_deref(), Some(""));
    }

    #[test]
    fn js_number_follows_string_to_number() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 5 "), 5.0);
        assert_eq!(js_number("2.5"), 2.5);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e1"), 10.0);
        assert_eq!(js_number("-3"), -3.0);
        assert!(js_number("abc").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("NaN").is_nan());
        assert!(js_number("0x").is_nan());
        assert_eq!(js_number("Infinity"), f64::INFINITY);
    }
}
