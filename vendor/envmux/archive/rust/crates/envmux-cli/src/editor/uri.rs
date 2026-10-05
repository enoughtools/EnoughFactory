//! Construction of the `vscode-remote://attached-container+…` URI.
//!
//! The format is undocumented (vscode-remote-release#5867), which is exactly
//! why every piece of it lives in this one pure module behind exhaustive
//! tests: `attached-container+<HEX>/<PATH>`, where `<HEX>` is the lowercase
//! hex of the UTF-8 bytes of the compact JSON `{"containerName":"/<name>"}`
//! (leading slash required, no whitespace) and `<PATH>` is the absolute
//! container-side folder, percent-encoded with an allow-list that never
//! touches `/`.

use super::EditorError;

/// Validate a container name against Docker's grammar and normalize it.
///
/// Docker sometimes reports names with a leading slash (`/test`); the JSON
/// payload requires exactly one. So: strip every leading slash, validate what
/// remains as `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, and let the payload builder
/// prepend the single slash. Validation is load-bearing for security, not
/// just correctness — on Windows the editor shim is a `.cmd` that runs
/// through the shell's interpreter, so a name that smuggles metacharacters
/// must never reach an argv.
pub fn normalize_container_name(raw: &str) -> Result<String, EditorError> {
    let name = raw.trim_start_matches('/');
    let mut chars = name.chars();
    let valid_first = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let valid_rest = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if valid_first && valid_rest {
        Ok(name.to_owned())
    } else {
        Err(EditorError::InvalidContainerName(raw.to_owned()))
    }
}

/// Lowercase hex of the UTF-8 bytes of `{"containerName":"/<name>"}`.
///
/// serde_json's `to_string` is the compact form — no spaces — and a
/// single-key object has no ordering to worry about.
fn hex_payload(name: &str) -> String {
    let payload = serde_json::json!({ "containerName": format!("/{name}") }).to_string();
    let mut hex = String::with_capacity(payload.len() * 2);
    for byte in payload.into_bytes() {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Percent-encode a container-side path with the allow-list
/// `[A-Za-z0-9-._~/]`. `/` is never encoded — it is the path structure.
/// Everything else is encoded per UTF-8 byte, uppercase hex per RFC 3986.
fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The complete folder URI for a container name and an absolute folder.
pub fn folder_uri(raw_name: &str, folder: &str) -> Result<String, EditorError> {
    let name = normalize_container_name(raw_name)?;
    // Belt and braces: the folder resolution chain only produces absolute
    // paths, but the URI is meaningless without the leading slash.
    let folder = if folder.starts_with('/') {
        folder.to_owned()
    } else {
        format!("/{folder}")
    };
    Ok(format!(
        "vscode-remote://attached-container+{}{}",
        hex_payload(&name),
        encode_path(&folder)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from the reference table, plus the short and the
    /// full-grammar names. These are the contract with VS Code: if one of
    /// them moves, the URI no longer opens.
    #[test]
    fn reference_vectors_match_vs_code() {
        assert_eq!(
            folder_uri("test", "/workspace").unwrap(),
            "vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a222f74657374227d/workspace"
        );
        assert_eq!(
            hex_payload("a"),
            "7b22636f6e7461696e65724e616d65223a222f61227d"
        );
        assert_eq!(
            hex_payload("my-app_1"),
            "7b22636f6e7461696e65724e616d65223a222f6d792d6170705f31227d"
        );
    }

    #[test]
    fn invalid_names_are_rejected_not_escaped() {
        // Escaping a hostile name would still hand it to a shell-adjacent
        // interpreter on Windows; rejection is the only safe answer.
        for bad in [
            "/",
            "",
            "has space",
            "quo\"te",
            "dol$lar",
            "semi;colon",
            "back`tick",
            "new\nline",
            "-leading-dash",
            "_leading-underscore",
            ".leading-dot",
        ] {
            assert!(
                matches!(
                    normalize_container_name(bad),
                    Err(EditorError::InvalidContainerName(_))
                ),
                "{bad:?} should have been rejected"
            );
        }
    }

    #[test]
    fn leading_slashes_are_stripped_then_exactly_one_is_prepended() {
        // Docker inspect reports "/test"; the payload wants "/test" — one
        // slash, however many arrived.
        assert_eq!(normalize_container_name("/test").unwrap(), "test");
        assert_eq!(normalize_container_name("//test").unwrap(), "test");
        let uri = folder_uri("//test", "/workspace").unwrap();
        assert_eq!(
            uri,
            "vscode-remote://attached-container+7b22636f6e7461696e65724e616d65223a222f74657374227d/workspace"
        );
    }

    #[test]
    fn hex_is_lowercase_and_even_length() {
        let hex = hex_payload("My-App.2");
        assert_eq!(hex.len() % 2, 0);
        assert!(
            hex.chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        );
        // And decodes back to the compact payload with the leading slash.
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"containerName":"/My-App.2"}"#
        );
    }

    #[test]
    fn path_encoding_never_touches_the_slashes() {
        // Space becomes %20; the separators stay separators.
        assert_eq!(encode_path("/work/my project"), "/work/my%20project");
        // Allow-list characters pass through untouched.
        assert_eq!(encode_path("/work/A-z0.9_~"), "/work/A-z0.9_~");
        // Non-ASCII is encoded per UTF-8 byte.
        assert_eq!(encode_path("/work/café"), "/work/caf%C3%A9");
        // The root path is a single slash, encoded as itself.
        assert_eq!(encode_path("/"), "/");
        let uri = folder_uri("test", "/").unwrap();
        assert!(
            uri.ends_with("227d/"),
            "root must keep its single slash: {uri}"
        );
    }

    #[test]
    fn a_64_char_hex_container_id_is_a_valid_name() {
        let id = "a".repeat(64);
        assert_eq!(normalize_container_name(&id).unwrap(), id);
        let id = "0123456789abcdef".repeat(4);
        assert!(folder_uri(&id, "/work").is_ok());
    }
}
