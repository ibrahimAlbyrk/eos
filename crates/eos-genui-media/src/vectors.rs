//! The pure parts against what the TypeScript computes
//! (`fixtures/genui-media/vectors.json`, frozen from the TypeScript, see `fixtures/README.md`).

use std::sync::LazyLock;

use eos_core::net::PlaceQuery;
use serde_json::Value;

use crate::cache::cache_key;
use crate::geo::nominatim::{area_of, to_geocode_result};
use crate::geo::overpass::{build_overpass_query, distance_m, element_to_place, format_distance, overpass_regex};
use crate::html_meta::{extract_icons, extract_preview_image, normalize_site};
use crate::map::{OPENFREEMAP_ORIGIN, rewrite_map_urls, upstream_url};
use crate::media::{etag_of, image_type_of, is_imageish, sniff_image_type};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/genui-media/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors file")).expect("json")
});

fn family(name: &str) -> &'static [Value] {
    VECTORS[name].as_array().unwrap_or_else(|| panic!("no vector family {name}"))
}

fn text(v: &Value) -> Option<&str> {
    v.as_str()
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect()
}

#[test]
fn pages_name_their_preview_image_and_icons() {
    for case in family("pages") {
        let (url, html) = (text(&case["url"]).expect("url"), text(&case["html"]).expect("html"));
        assert_eq!(extract_preview_image(html, url).as_deref(), text(&case["preview"]), "preview of {html}");
        // Where the TypeScript throws (a page URL that is not one), there is no icon.
        let icons: Vec<&str> =
            case["icons"].as_array().map(|icons| icons.iter().filter_map(text).collect()).unwrap_or_default();
        assert_eq!(extract_icons(html, url), icons, "icons of {html}");
    }
}

#[test]
fn sites_are_normalized() {
    for case in family("sites") {
        let site = text(&case["site"]).expect("site");
        assert_eq!(normalize_site(site).as_deref(), text(&case["host"]), "{site:?}");
    }
}

#[test]
fn image_types_are_sniffed() {
    for case in family("images") {
        let body = bytes(text(&case["hex"]).expect("hex"));
        assert_eq!(sniff_image_type(&body), text(&case["sniffed"]), "{}", case["hex"]);
        assert_eq!(image_type_of("application/octet-stream", &body).as_deref(), text(&case["asOctetStream"]));
        assert_eq!(image_type_of("image/png", &body).as_deref(), text(&case["asDeclaredPng"]));
    }
    for case in family("imageish") {
        assert_eq!(Some(is_imageish(text(&case["type"]).expect("type"))), case["ok"].as_bool(), "{}", case["type"]);
    }
    for case in family("etags") {
        assert_eq!(Some(etag_of(&bytes(text(&case["hex"]).expect("hex"))).as_str()), text(&case["etag"]));
    }
    for case in family("cacheKeys") {
        let key = cache_key(text(&case["namespace"]).expect("namespace"), text(&case["url"]).expect("url"));
        assert_eq!(Some(key.as_str()), text(&case["key"]));
    }
}

#[test]
fn map_documents_point_back_at_the_proxy() {
    for case in family("rewrites") {
        let value: eos_genui::Value = serde_json::from_value(case["value"].clone()).expect("a value");
        let rewritten = rewrite_map_urls(value, OPENFREEMAP_ORIGIN, "/api/genui/map/t");
        assert_eq!(Some(rewritten.to_json().as_str()), text(&case["json"]));
    }
    for case in family("upstream") {
        let path = text(&case["path"]).expect("path");
        assert_eq!(upstream_url(OPENFREEMAP_ORIGIN, path).as_deref(), text(&case["url"]), "{path:?}");
    }
}

#[test]
fn nominatim_answers_are_read() {
    for case in family("areas") {
        let area = area_of(Some(&case["address"]).filter(|address| !address.is_null()));
        assert_eq!(serde_json::to_value(&area).expect("json"), case["area"], "{}", case["address"]);
    }
    for case in family("geocodeResults") {
        let result = to_geocode_result(&case["place"]);
        assert_eq!(serde_json::to_value(&result).expect("json"), case["result"], "{}", case["place"]);
    }
}

fn place_query(q: &Value) -> PlaceQuery {
    PlaceQuery {
        query: text(&q["query"]).map(str::to_owned),
        category: text(&q["category"]).map(str::to_owned),
        lat: q["center"]["lat"].as_f64().expect("lat"),
        lon: q["center"]["lon"].as_f64().expect("lon"),
        radius_m: q["radiusM"].as_f64().expect("radius"),
        limit: usize::try_from(q["limit"].as_u64().expect("limit")).expect("limit"),
    }
}

#[test]
fn overpass_queries_are_built() {
    for case in family("regexes") {
        assert_eq!(Some(overpass_regex(text(&case["text"]).expect("text")).as_str()), text(&case["regex"]));
    }
    for case in family("queries") {
        assert_eq!(Some(build_overpass_query(&place_query(&case["q"])).as_str()), text(&case["ql"]), "{}", case["q"]);
    }
}

#[test]
fn distances_are_measured_and_worded() {
    let point = |p: &Value| (p["lat"].as_f64().expect("lat"), p["lon"].as_f64().expect("lon"));
    for case in family("distances") {
        let (ours, theirs) = (distance_m(point(&case["a"]), point(&case["b"])), case["m"].as_f64().expect("m"));
        // The same formula over another maths library: equal to a hair.
        assert!((ours - theirs).abs() <= theirs.abs() * 1e-12 + 1e-9, "{ours} vs {theirs}");
    }
    for case in family("formatted") {
        let m = case["m"].as_f64().expect("m");
        assert_eq!(Some(format_distance(m).as_str()), text(&case["text"]), "{m}");
    }
}

#[test]
fn elements_become_places() {
    let center = (40.9876, 29.0321);
    for case in family("elements") {
        let place = element_to_place(&case["el"], center).map(|(place, _)| place);
        assert_eq!(place.unwrap_or(Value::Null), case["place"], "{}", case["el"]);
    }
}
