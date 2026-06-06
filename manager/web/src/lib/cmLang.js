import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { sCSS, less } from "@codemirror/legacy-modes/mode/css";

const legacy = (mode) => StreamLanguage.define(mode);

const LANGS = {
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  json5: () => json(),
  md: () => markdown(),
  mdx: () => markdown(),
  css: () => css(),
  scss: () => legacy(sCSS),
  less: () => legacy(less),
  html: () => html(),
  htm: () => html(),
  xml: () => xml(),
  svg: () => xml(),
  py: () => python(),
  rb: () => legacy(ruby),
  rs: () => rust(),
  go: () => go(),
  java: () => java(),
  kt: () => legacy(kotlin),
  cs: () => legacy(csharp),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  hpp: () => cpp(),
  swift: () => legacy(swift),
  sh: () => legacy(shell),
  bash: () => legacy(shell),
  zsh: () => legacy(shell),
  sql: () => sql(),
  yaml: () => yaml(),
  yml: () => yaml(),
  toml: () => legacy(toml),
  ini: () => legacy(properties),
  lua: () => legacy(lua),
  r: () => legacy(r),
  php: () => php(),
  pl: () => legacy(perl),
  diff: () => legacy(diff),
  patch: () => legacy(diff),
  dockerfile: () => legacy(dockerFile),
};

export function cmLanguageFor(filePath) {
  if (!filePath) return null;
  const name = filePath.split("/").pop().toLowerCase();
  const key = name.includes(".") ? name.split(".").pop() : name;
  return LANGS[key]?.() ?? null;
}
