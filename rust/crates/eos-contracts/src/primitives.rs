//! Shapes every module shares: JavaScript numbers, literal-valued fields and
//! the serde helpers that keep "absent", `null` and a value apart.

use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A JSON number as JavaScript holds it (`z.number()` without `.int()`).
///
/// Serializes the way `JSON.stringify` does: a whole value has no fraction
/// (`50`, never `50.0`), so a row read from today's wire writes back equal.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct Num(pub f64);

// 2^53: every whole f64 below it is an exact integer.
const SAFE_INT: f64 = 9_007_199_254_740_992.0;

impl Num {
    pub fn as_f64(self) -> f64 {
        self.0
    }

    /// The value as an integer when it is one.
    pub fn as_i64(self) -> Option<i64> {
        #[allow(clippy::cast_possible_truncation)]
        (self.0.fract() == 0.0 && self.0.abs() < SAFE_INT).then_some(self.0 as i64)
    }
}

impl From<f64> for Num {
    fn from(v: f64) -> Self {
        Self(v)
    }
}

macro_rules! num_from_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Num {
            #[allow(clippy::cast_precision_loss, clippy::cast_lossless)]
            fn from(v: $t) -> Self {
                Self(v as f64)
            }
        }
    )*};
}
num_from_int!(i32, u32, i64, u64, usize);

impl fmt::Display for Num {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.as_i64() {
            Some(i) => write!(f, "{i}"),
            None => write!(f, "{}", self.0),
        }
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.as_i64() {
            Some(i) => s.serialize_i64(i),
            None => s.serialize_f64(self.0),
        }
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        f64::deserialize(d).map(Self)
    }
}

impl JsonSchema for Num {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Num".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "number" })
    }
}

/// A field that only ever holds one boolean (`z.literal(true)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct BoolLit<const V: bool>;

impl<const V: bool> Serialize for BoolLit<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(V)
    }
}

impl<'de, const V: bool> Deserialize<'de> for BoolLit<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let got = bool::deserialize(d)?;
        if got == V { Ok(Self) } else { Err(serde::de::Error::custom(format_args!("invalid literal, expected {V}"))) }
    }
}

impl<const V: bool> JsonSchema for BoolLit<V> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("BoolLit_{V}").into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "const": V })
    }
}

/// A field that only ever holds one integer (`z.literal(1)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct IntLit<const V: i64>;

impl<const V: i64> Serialize for IntLit<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_i64(V)
    }
}

impl<'de, const V: i64> Deserialize<'de> for IntLit<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let got = Num::deserialize(d)?;
        if got.as_i64() == Some(V) {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format_args!("invalid literal, expected {V}")))
        }
    }
}

impl<const V: i64> JsonSchema for IntLit<V> {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("IntLit_{V}").into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "const": V })
    }
}

/// Declares a type for a field that only ever holds one string
/// (`z.literal("text")`).
macro_rules! str_lit {
    ($(#[$meta:meta])* $vis:vis $name:ident = $value:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
        $vis struct $name;

        impl $name {
            pub const VALUE: &'static str = $value;
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str($value)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let got = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                if got == $value {
                    Ok(Self)
                } else {
                    Err(serde::de::Error::custom(concat!("invalid literal, expected \"", $value, "\"")))
                }
            }
        }

        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }
            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({ "const": $value })
            }
        }

        impl $crate::validate::Validate for $name {}
    };
}
pub(crate) use str_lit;

/// `default = "…"` for a field that is `true` when absent.
pub(crate) fn yes() -> bool {
    true
}

/// serde helpers named from field attributes.
pub(crate) mod de {
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;

    /// What `String.prototype.trim` strips (not the same set as `str::trim`:
    /// U+FEFF counts, U+0085 does not).
    fn is_js_space(c: char) -> bool {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    }

    pub(crate) fn js_trim(s: &str) -> &str {
        s.trim_matches(is_js_space)
    }

    /// `z.string().trim()`: the stored value is the trimmed one.
    pub(crate) fn trimmed<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        let s = String::deserialize(d)?;
        let t = js_trim(&s);
        Ok(if t.len() == s.len() { s } else { t.to_owned() })
    }

    pub(crate) fn trimmed_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
        Ok(Option::<String>::deserialize(d)?.map(|s| js_trim(&s).to_owned()))
    }

    pub(crate) fn trimmed_nullable<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(Option::<String>::deserialize(d)?.map(|s| js_trim(&s).to_owned())))
    }

    /// For a nullable field that must still be present: without it serde
    /// reads a missing `Option` as `None`, where Zod answers "Required".
    pub(crate) fn required<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
        Option::<T>::deserialize(d)
    }

    /// For `z.unknown()`: a key that is present keeps its value, `null`
    /// included, so "absent" and `null` stay apart through a round trip.
    pub(crate) fn some<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
        Value::deserialize(d).map(Some)
    }

    /// JavaScript's `Number(text)` for the forms a query string carries.
    fn js_number(text: &str) -> f64 {
        let t = js_trim(text);
        if t.is_empty() {
            return 0.0;
        }
        match t {
            "Infinity" | "+Infinity" => return f64::INFINITY,
            "-Infinity" => return f64::NEG_INFINITY,
            _ => {}
        }
        if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
            #[allow(clippy::cast_precision_loss)]
            return u64::from_str_radix(hex, 16).map_or(f64::NAN, |v| v as f64);
        }
        // Rust would also take "inf", "nan" and "1_0"; JavaScript does not.
        if !t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
            return f64::NAN;
        }
        t.parse().unwrap_or(f64::NAN)
    }

    fn coerced_int<E: serde::de::Error>(v: &Value) -> Result<i64, E> {
        let n = match v {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) => js_number(s),
            Value::Bool(b) => f64::from(u8::from(*b)),
            Value::Null => 0.0,
            Value::Array(_) | Value::Object(_) => f64::NAN,
        };
        if n.is_nan() {
            return Err(E::custom("Expected number, received nan"));
        }
        super::Num(n).as_i64().ok_or_else(|| E::custom("Expected integer, received float"))
    }

    /// `z.coerce.number().int()`: query parameters arrive as text.
    pub(crate) fn coerce_int<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        coerced_int(&Value::deserialize(d)?)
    }

    pub(crate) fn coerce_int_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        coerced_int(&Value::deserialize(d)?).map(Some)
    }

    /// `z.coerce.boolean()` is JavaScript's `Boolean(x)`: every non-empty
    /// string is true, `"false"` and `"0"` included.
    pub(crate) fn coerce_bool_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
        Ok(Some(match Value::deserialize(d)? {
            Value::Bool(b) => b,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
            Value::Null => false,
            Value::Array(_) | Value::Object(_) => true,
        }))
    }

    /// For `nullable().optional()` as `Option<Option<T>>`: `None` = key
    /// absent, `Some(None)` = `null`.
    pub(crate) fn nullable<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn num_prints_like_javascript() {
        for (v, text) in [(50.0, "50"), (-0.0, "0"), (1.5, "1.5"), (1_731_312_000_000.0, "1731312000000"), (0.1, "0.1")]
        {
            assert_eq!(serde_json::to_string(&Num(v)).unwrap(), text);
        }
        assert_eq!(serde_json::to_string(&Num(f64::NAN)).unwrap(), "null");
        assert_eq!(serde_json::from_str::<Num>("3").unwrap(), Num(3.0));
    }

    #[test]
    fn literals_accept_only_their_value() {
        assert!(serde_json::from_value::<BoolLit<true>>(json!(true)).is_ok());
        assert!(serde_json::from_value::<BoolLit<true>>(json!(false)).is_err());
        assert!(serde_json::from_value::<IntLit<3>>(json!(3)).is_ok());
        assert!(serde_json::from_value::<IntLit<3>>(json!(4)).is_err());
        assert_eq!(serde_json::to_value(IntLit::<3>).unwrap(), json!(3));
    }

    #[test]
    fn trim_follows_javascript() {
        assert_eq!(de::js_trim("\u{feff} a\u{a0}\n"), "a");
        assert_eq!(de::js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn absent_null_and_value_stay_apart() {
        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Row {
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::nullable")]
            a: Option<Option<i64>>,
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de::some")]
            b: Option<serde_json::Value>,
        }
        for v in [json!({}), json!({"a": null, "b": null}), json!({"a": 1, "b": [1]})] {
            let row: Row = serde_json::from_value(v.clone()).unwrap();
            assert_eq!(serde_json::to_value(&row).unwrap(), v);
        }
    }
}
