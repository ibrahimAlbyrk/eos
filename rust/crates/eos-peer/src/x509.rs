//! A minimal self-signed X.509 certificate for a device identity, in the
//! exact structure today's generator writes (`infra/src/peer/x509.ts`): v3,
//! an ECDSA P-256 key, the fixed name `eos-device`, no extensions, valid from
//! yesterday to 9999-12-31. Chains are never validated — both ends pin the
//! fingerprint — so the certificate only has to carry a key that TLS proves
//! possession of.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::Error;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// RFC 5280's "no well-defined expiration": an identity lives until re-paired.
const NOT_AFTER: &str = "99991231235959Z";
const COMMON_NAME: &str = "eos-device";

fn der_length(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![n as u8];
    }
    let bytes: Vec<u8> = n.to_be_bytes().into_iter().skip_while(|b| *b == 0).collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(der_length(content.len()));
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

fn integer(bytes: &[u8]) -> Vec<u8> {
    let mut b = bytes;
    while b.len() > 1 && b[0] == 0 && b[1] & 0x80 == 0 {
        b = &b[1..];
    }
    if b.first().is_some_and(|first| first & 0x80 != 0) {
        return tlv(0x02, &[&[0u8][..], b].concat());
    }
    tlv(0x02, b)
}

// 1.2.840.10045.4.3.2 (ecdsa-with-SHA256), 2.5.4.3 (commonName),
// 1.2.840.10045.2.1 (ecPublicKey), 1.2.840.10045.3.1.7 (prime256v1).
const OID_ECDSA_SHA256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_COMMON_NAME: &[u8] = &[0x06, 0x03, 0x55, 0x04, 0x03];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_PRIME256V1: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

fn name(cn: &str) -> Vec<u8> {
    seq(&[&tlv(0x31, &seq(&[OID_COMMON_NAME, &tlv(0x0c, cn.as_bytes())]))])
}

/// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
fn time(ms: i64) -> Vec<u8> {
    let iso = eos_domain::time::iso_from_ms(ms);
    let digits: String = iso.chars().filter(char::is_ascii_digit).take(14).collect();
    let stamp = format!("{digits}Z");
    if iso.get(..4).and_then(|y| y.parse::<u32>().ok()).is_some_and(|year| year < 2050) {
        tlv(0x17, &stamp.as_bytes()[2..])
    } else {
        tlv(0x18, stamp.as_bytes())
    }
}

fn pem(label: &str, der: &[u8]) -> String {
    let encoded = STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// A new identity: `(key PEM (PKCS#8), certificate PEM)`.
pub(crate) fn create_self_signed(now_ms: i64) -> Result<(String, String), Error> {
    let fail = |what: &str| Error::KeyGeneration(what.to_owned());
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).map_err(|_| fail("no key"))?;
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref())
        .map_err(|_| fail("the new key could not be read back"))?;

    let mut serial = [0u8; 16];
    getrandom::fill(&mut serial).map_err(|_| fail("no random serial"))?;
    let algorithm = seq(&[OID_ECDSA_SHA256]);
    // SubjectPublicKeyInfo: the curve, then the point as a bit string.
    let point = [&[0u8][..], key.public_key().as_ref()].concat();
    let spki = seq(&[&seq(&[OID_EC_PUBLIC_KEY, OID_PRIME256V1]), &tlv(0x03, &point)]);
    let tbs = seq(&[
        &tlv(0xa0, &integer(&[2])), // [0] EXPLICIT version v3
        &integer(&serial),
        &algorithm,
        &name(COMMON_NAME),
        &seq(&[&time(now_ms - DAY_MS), &tlv(0x18, NOT_AFTER.as_bytes())]),
        &name(COMMON_NAME),
        &spki,
    ]);
    let signature = key.sign(&rng, &tbs).map_err(|_| fail("the certificate could not be signed"))?;
    let der = seq(&[&tbs, &algorithm, &tlv(0x03, &[&[0u8][..], signature.as_ref()].concat())]);
    Ok((pem("PRIVATE KEY", pkcs8.as_ref()), pem("CERTIFICATE", &der)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_and_integers_are_der() {
        assert_eq!(der_length(0x7f), [0x7f]);
        assert_eq!(der_length(0x80), [0x81, 0x80]);
        assert_eq!(der_length(0x1234), [0x82, 0x12, 0x34]);
        assert_eq!(integer(&[0x00, 0x00, 0x7f]), [0x02, 0x01, 0x7f]);
        assert_eq!(integer(&[0x00, 0x80]), [0x02, 0x02, 0x00, 0x80]);
        assert_eq!(integer(&[0x80]), [0x02, 0x02, 0x00, 0x80]);
        assert_eq!(integer(&[2]), [0x02, 0x01, 0x02]);
    }

    #[test]
    fn a_date_before_2050_is_utc_time_and_a_later_one_generalized() {
        assert_eq!(time(1_700_000_000_000), tlv(0x17, b"231114221320Z"));
        assert_eq!(time(2_600_000_000_000), tlv(0x18, b"20520522141320Z"));
    }
}
