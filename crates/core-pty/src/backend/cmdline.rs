//! The Windows command line a terminal process starts with.
//!
//! `CreateProcessW` takes one string and each program splits it itself, so a
//! list of arguments is quoted with the rules the MSVC runtime parses back.
//! `Args::CommandLine` is appended untouched: `cmd.exe /d /s /c "…"` reads
//! everything after `/c` with its own rules, and re-quoting it breaks them.
//! Built on every platform so its tests run everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use super::Args;

pub fn command_line(program: &str, args: &Args) -> String {
    let mut line = quote(program);
    match args {
        Args::List(args) => {
            for arg in args {
                line.push(' ');
                line.push_str(&quote(arg));
            }
        }
        Args::CommandLine(rest) if !rest.is_empty() => {
            line.push(' ');
            line.push_str(rest);
        }
        Args::CommandLine(_) => {}
    }
    line
}

/// One argument as the MSVC runtime reads it back: quoted only when it has to
/// be, and backslashes doubled only where they precede a quote.
fn quote(arg: &str) -> String {
    let needs_quotes = arg.is_empty() || arg.contains([' ', '\t', '\n', '\x0b', '"']);
    if !needs_quotes {
        return arg.to_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(ch);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::{Args, command_line};

    fn list(args: &[&str]) -> Args {
        Args::List(args.iter().map(|a| (*a).to_owned()).collect())
    }

    #[test]
    fn leaves_plain_arguments_alone() {
        assert_eq!(command_line("bun", &list(&["run", "dev"])), "bun run dev");
    }

    #[test]
    fn quotes_arguments_with_spaces_quotes_or_nothing() {
        assert_eq!(
            command_line(
                r"C:\Program Files\Git\bin\bash.exe",
                &list(&["-c", "echo hi", ""])
            ),
            r#""C:\Program Files\Git\bin\bash.exe" -c "echo hi" """#,
        );
        assert_eq!(
            command_line("x", &list(&[r#"say "hi""#])),
            r#"x "say \"hi\"""#
        );
    }

    #[test]
    fn doubles_backslashes_only_before_a_quote() {
        assert_eq!(command_line("x", &list(&[r"C:\dir\"])), r"x C:\dir\");
        assert_eq!(
            command_line("x", &list(&[r"C:\my dir\"])),
            r#"x "C:\my dir\\""#
        );
        assert_eq!(command_line("x", &list(&[r#"a\"b c"#])), r#"x "a\\\"b c""#);
    }

    /// The sign-in launch for an npm shim: `resolveAgentCommand` builds the
    /// `/c` line with cmd.exe caret escapes, and it must arrive byte for byte.
    #[test]
    fn appends_a_command_line_verbatim() {
        let rest = r#"/d /s /c "C:\Users\me\AppData\Roaming\npm\claude.cmd ^"auth^" ^"login^"""#;
        assert_eq!(
            command_line(
                r"C:\Windows\system32\cmd.exe",
                &Args::CommandLine(rest.into())
            ),
            format!(r"C:\Windows\system32\cmd.exe {rest}"),
        );
        assert_eq!(
            command_line("cmd.exe", &Args::CommandLine(String::new())),
            "cmd.exe"
        );
    }
}
