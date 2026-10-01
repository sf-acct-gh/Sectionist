// Text-encoding detection and conversion for opening/saving arbitrary text
// files (not just UTF-8). See AGENTS.md "Encoding" and the Encoding menu in
// menu.rs.
//
// Detection order: BOM first (unambiguous when present, and covers UTF-8/
// UTF-16LE/UTF-16BE in one check via encoding_rs's own BOM sniffer), then
// strict UTF-8 validation (the common no-BOM case — this must run before any
// heuristic, since almost all modern text files are exactly this), then a
// best-effort legacy single/multi-byte codepage guess via chardetng (covers
// "the system ANSI code page" in a way that isn't tied to one specific OS/
// locale, e.g. Windows-1252/1251/Shift_JIS). A file that fails every one of
// these is reported as unsupported rather than silently mangled.
//
// Deliberately NOT attempted: guessing UTF-16 from an even byte count with no
// BOM. Real UTF-16 producers always write a BOM; without one, "every other
// byte is plausible" is true of a huge range of legacy single-byte text too
// (an even-length Windows-1252/Shift_JIS file matches just as easily), so
// this heuristic did far more harm (misdetecting real legacy-encoded files as
// UTF-16) than good (recovering the vanishingly rare BOM-less UTF-16 file).

use encoding_rs::Encoding;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: [u8; 2] = [0xFF, 0xFE];
const UTF16BE_BOM: [u8; 2] = [0xFE, 0xFF];

/// Detects `bytes`' encoding and decodes to a Rust (UTF-8) String. Returns
/// the decoded text plus an id string identifying the original encoding, so
/// a later save can round-trip back to the same on-disk format (see
/// `encode_for_save`).
pub fn detect_and_decode(bytes: &[u8]) -> Result<(String, String), String> {
    if bytes.is_empty() {
        return Ok((String::new(), "utf8".to_string()));
    }

    if let Some((encoding, bom_len)) = Encoding::for_bom(bytes) {
        let rest = &bytes[bom_len..];
        return if encoding == encoding_rs::UTF_8 {
            match std::str::from_utf8(rest) {
                Ok(text) => Ok((text.to_string(), "utf8-bom".to_string())),
                Err(_) => Err("File has a UTF-8 byte-order mark but is not valid UTF-8.".to_string()),
            }
        } else {
            let (text, had_errors) = encoding.decode_without_bom_handling(rest);
            if had_errors {
                Err(format!(
                    "File has a {} byte-order mark but could not be decoded.",
                    encoding.name()
                ))
            } else {
                let id = if encoding == encoding_rs::UTF_16LE { "utf16le" } else { "utf16be" };
                Ok((text.into_owned(), id.to_string()))
            }
        };
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_string(), "utf8".to_string()));
    }

    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let guessed = detector.guess(None, false);
    let (text, had_errors) = guessed.decode_without_bom_handling(bytes);
    if !had_errors && looks_like_plain_text(&text) {
        return Ok((text.into_owned(), legacy_id(guessed)));
    }

    Err("Unsupported Encoding".to_string())
}

/// Re-encodes `contents` back to bytes matching the encoding identified by
/// `encoding_id` (as produced by `detect_and_decode`, or chosen manually from
/// the Encoding menu), so subsequent saves preserve the file's original
/// on-disk format.
///
/// For a legacy single/multi-byte codepage, `encoding_rs::Encoding::encode`
/// follows the WHATWG Encoding Standard's "encode" algorithm: a character
/// that cannot be represented replaces it with a decimal HTML numeric
/// character reference (e.g. `&#128512;`) rather than failing. That is
/// correct for encoding an HTML form field, but silently writing that mangled
/// text to the user's actual file would be data corruption — so `had_errors`
/// is checked here and turned into a save-blocking error instead.
pub fn encode_for_save(contents: &str, encoding_id: &str) -> Result<Vec<u8>, String> {
    match encoding_id {
        "utf8" => Ok(contents.as_bytes().to_vec()),
        "utf8-bom" => {
            let mut out = UTF8_BOM.to_vec();
            out.extend_from_slice(contents.as_bytes());
            Ok(out)
        }
        "utf16le" => {
            let mut out = UTF16LE_BOM.to_vec();
            for unit in contents.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        "utf16be" => {
            let mut out = UTF16BE_BOM.to_vec();
            for unit in contents.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(out)
        }
        legacy => match Encoding::for_label(legacy.as_bytes()) {
            Some(encoding) => {
                let (bytes, _, had_errors) = encoding.encode(contents);
                if had_errors {
                    Err(format!(
                        "This document contains characters that cannot be represented in {}. \
                         Switch its encoding to UTF-8 (Encoding menu) before saving, or undo the \
                         change that introduced them.",
                        encoding.name()
                    ))
                } else {
                    Ok(bytes.into_owned())
                }
            }
            // Unknown id (shouldn't happen in practice).
            None => Err(format!("Unknown encoding '{legacy}'.")),
        },
    }
}

/// Rejects decode results that are technically well-formed but obviously
/// wrong (e.g. treating an arbitrary binary file as UTF-16 often "succeeds"
/// with no replacement characters yet produces mostly control characters).
/// A generous but not-infinite tolerance for control characters (tabs/
/// newlines/carriage-returns are common and excluded) keeps this from
/// rejecting legitimate text that happens to contain a few oddities.
fn looks_like_plain_text(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    let mut control_count = 0usize;
    let mut total = 0usize;
    for ch in text.chars() {
        total += 1;
        if ch.is_control() && ch != '\t' && ch != '\n' && ch != '\r' {
            control_count += 1;
        }
    }
    (control_count as f64) / (total as f64) < 0.01
}

fn legacy_id(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_plain_utf8_with_no_bom() {
        let (text, id) = detect_and_decode("hello, world".as_bytes()).unwrap();
        assert_eq!(text, "hello, world");
        assert_eq!(id, "utf8");
    }

    #[test]
    fn detects_utf8_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("hi".as_bytes());
        let (text, id) = detect_and_decode(&bytes).unwrap();
        assert_eq!(text, "hi");
        assert_eq!(id, "utf8-bom");
    }

    #[test]
    fn detects_utf16le_and_utf16be_boms() {
        let (text, id) = detect_and_decode(&[0xFF, 0xFE, b'A', 0x00]).unwrap();
        assert_eq!(text, "A");
        assert_eq!(id, "utf16le");

        let (text, id) = detect_and_decode(&[0xFE, 0xFF, 0x00, b'A']).unwrap();
        assert_eq!(text, "A");
        assert_eq!(id, "utf16be");
    }

    // Regression test for the exact bug reported by real usage: a legacy
    // single-byte-encoded file with no BOM, whose byte length happens to be
    // even, was previously misdetected as UTF-16 instead of falling through
    // to the chardetng legacy-codepage guess.
    #[test]
    fn even_length_legacy_encoded_text_is_not_misdetected_as_utf16() {
        let (text, _, _) = encoding_rs::WINDOWS_1252.encode("café au lait!!"); // 14 bytes, even
        assert_eq!(text.len() % 2, 0);
        let (decoded, id) = detect_and_decode(&text).unwrap();
        assert_ne!(id, "utf16le");
        assert_ne!(id, "utf16be");
        assert_eq!(decoded, "café au lait!!");
    }

    #[test]
    fn round_trips_windows_1252_content() {
        let original = "Résumé — “quoted”";
        let (text, id) = detect_and_decode(
            &encoding_rs::WINDOWS_1252.encode(original).0,
        )
        .unwrap();
        assert_eq!(text, original);
        let bytes = encode_for_save(&text, &id).unwrap();
        let (roundtripped, _) = detect_and_decode(&bytes).unwrap();
        assert_eq!(roundtripped, original);
    }

    // Regression test for the data-corruption bug: encoding_rs silently
    // replaces characters a legacy codepage can't represent with HTML
    // numeric character references instead of failing, so writing the
    // result straight to disk mangled the file. encode_for_save must reject
    // this instead of returning the mangled bytes.
    #[test]
    fn encode_for_save_rejects_characters_unmappable_in_target_legacy_encoding() {
        // A CJK character has no representation in Windows-1252.
        let result = encode_for_save("hello 日本語", "windows-1252");
        assert!(result.is_err());
    }

    #[test]
    fn encode_for_save_utf8_never_fails() {
        assert!(encode_for_save("hello 日本語 🎉", "utf8").is_ok());
    }

    #[test]
    fn undecodable_binary_garbage_is_rejected() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        assert!(detect_and_decode(&bytes).is_err());
    }
}
