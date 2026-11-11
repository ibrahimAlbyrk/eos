// The markup grammar: hand-picked edge cases, every prefix of two documents, and
// seeded noise.

import { prng } from "../lib/encode.mjs";

const CASES = [
  "", " ", "\n\n", "plain text", "a < b and c > d", "<", "<<<>>>", "< Stack>", "<1a>", "</>", "</ Stack>", "</Stack>", "<Stack", "<Stack ", "<Stack/", "<Stack /", "<Stack/>", "<Stack></Stack>",
  "<Stack>\n  <Text>hi</Text>\n</Stack>", "<Stack><Text>a</Stack>", "<Stack><Text>a</Text>", "<a><b><c></a>", "<a></b></a>", "<a></b>", "text <b>bold</b> tail",
  '<Card of="places" pick="moda"/>', "<Card of='places' pick='moda'/>", "<Card of=places pick=moda/>", "<Card of=places/>", "<Card of=places>", "<Card of = \"x\"/>", "<Card of\t=\n\"x\"/>", "<Card of =x y/>",
  '<Card flag/>', "<Card flag other/>", "<Card flag = />", '<Card a="1" a="2"/>', "<Card a a/>", '<Card __proto__="x" constructor="y" toString/>',
  '<T a="x &amp; y &lt;b&gt; &quot;q&quot; &apos;s&apos; &#39; &nbsp; &amp;amp;"/>', "<T a='it&#39;s'/>", '<T a="say \\"hi\\""/>', "<T a='it\\'s'/>", '<T a="back\\\\slash"/>', '<T a="\\\\"/>',
  '<T a="unclosed/>', "<T a='unclosed>", '<T a="x" b="unclosed', '<T a=>', "<T a=/>", "<T a= />", "<T =a/>", '<T "a"/>', "<T {a}/>", "<T a/ b/>", "<T / >", "<T a=b/c/>", "<T a=b/>", "<T a=b//>",
  "<T n={3}/>", "<T n={-1.5e3}/>", '<T l={["a","b"]}/>', "<T o={{\"a\":{\"b\":[1,2,{\"c\":\"}\"}]}}}/>", "<T o={{a: 'x', b: [1, 2,], /* c */ }}/>", "<T o={ null }/>", "<T o={true}/>", "<T o={}/>", "<T o={ }/>",
  "<T o={not json}/>", "<T o={[1,2}/>", "<T o={{\"a\":1]}/>", "<T o={\"unclosed}/>", "<T o={'a}'}/>", "<T o={\"a\\\"}\"}/>", "<T o={[}/>", "<T o={{}/>", "<T o={1} p={2}/>", "<T o={1 2}/>", "<T o={NaN}/>",
  "<T o={/* c */ 1}/>", "<T o={// c\n1}/>", "<T o={'it\\'s'}/>", "<T o={{\"__proto__\":1,\"2\":0,\"1\":0,\"b\":0}}/>",
  "<Code>let a = 1 < 2;</Code>", "<Code>\n  if (x) {\n    y();\n  }\n</Code>", "<Code>\r\n\tline\r\n</Code>", "<Code></Code>", "<Code>  </Code>", "<Code>", "<Code>never closed", "<Code>a</Code", "<Code>a</Cod", "<Code lang=\"js\">a<b>c</b></Code>tail",
  "<Code>one</Code><Code>two</Code>", "<Code>a</Code >", "<Code>a</Codex>", "<Code/>", "<code>x</code>",
  "<!-- c --><Text>a</Text>", "<Text>a<!-- c -->b</Text>", "<!-- never closed <Text>a</Text>", "<!---->", "<!-->", "<!- x -->", "a<!--b-->c",
  "<Text>\n    first\n      second\n    third\n</Text>", "<Text>one\n  two\n   three</Text>", "<Text>  lead\n\ttab</Text>", "<Text>a\n\nb</Text>", "<Text> nbsp </Text>", "<Text> ls </Text>", "<Text>﻿bom</Text>",
  "<Text>a</Text>\r\n<Text>b</Text>\r\n", "line1\nline2 <Bad\nline3", "<Text>😀 emoji 𝒜</Text>", '<Text 😀="x"/>', "<Te😀xt/>", '<T a="😀"/>', "<T a=😀/>", "<T 𝒜/>", "é<É/>", "<T é=1/>",
  "<Stack.Item/>", "<a-b c-d=\"1\" e.f=\"2\" g:h=\"3\" @i=\"4\" _j=\"5\"/>", "<A1_.-/>", '<T title="' + "x".repeat(30) + '"/>', '<T of="a" pick="b" bind="c" type="d"/>', '<T title="' + "😀".repeat(13) + '"/>', '<T label="' + "ab".repeat(11) + "😀" + '"/>',
  "<Tabs><Stack label=\"A\"><Text>a</Text></Stack><Stack label=\"B\"/></Tabs>", "<List of=\"places\"><Text>{name}</Text></List>", "<Text>{name} costs {price * 2}</Text>",
  "<Text>\u0085</Text>", "<Text>\u200b</Text>", "<Text>\u3000 wide \u3000</Text>", "<T\u00a0a=1/>", "<T a\u00a0=\u00a01/>", "<T a=1\u2028b=2/>", "<T a\ufeff/>", "<T a=1\u0085/>", "<Code>\u00a0\n  x\u3000\n</Code>", "\u0085<T/>\u0085",
  "</a></b>", "<a></a></a>", "<a><b></b></a></b>", "<a><b><c><d></b></a>", "<a>t1<b>t2</b>t3</a>t4", "<a>\n</a>", "<a> </a>", "<a>x<b/>y<c/>z</a>",
  "<Stack><Text>a</Text><Text>b", "<Stack><Stack><Text>a</Text>", "<Stack><Text>a</Text>trailing", "<Stack>lead<Text>a</Text>", "<Stack><Text>a</Text></Sta", "<Stack><Text>a</Text><", "<Stack><Text>a</Text></",
];

const EDGE = `<Section title="Kadıköy &amp; Moda" icon='map' collapsed>
  <!-- header -->
  <Stack dir="row" gap=sm wrap>
    <Text size="lg">**Tonight** — a < b, 2 > 1 😀</Text>
    <Badge tone="green" n={3} list={["a", "b}", {"k": [1, 2]}]}>open</Badge>
  </Stack>
  <Code lang="ts" title='x'>
    if (a < b) {
      return "<Tag>";
    }
  </Code>
  <Carousel of="places" where="rating >= 4.5 && tags ~ 'sea'" meta="{cuisine} · {area}" actions="book route"/>
  <Table of="places" cols={[{"key":"name","label":"Venue"}, "rating"]} best numbered></Table>
  <Value expr="sum(places.price) / count(places)" label = "Avg" format="number"/>
  <Tabs bind="tab">\r
    <Stack label="Bir">\tİlk 𝒜</Stack>
    <Stack label="İki"><Text>ikinci</Text></Stack>
  </Tabs>
  <b>html</b> <Unknown a=1 b='2' c="\\"q\\""/>
</Section>
<Map of="places" you={[40.98, 29.02]} route/>
tail text`;

const FRAGMENTS = [
  "<", ">", "/", "</", "/>", "=", '"', "'", "{", "}", "[", "]", " ", " ", "\n", "\t", "Stack", "Text", "Code", "a", "b", "of", "x", "1", ":", ",", "&amp;", "&lt;", "&", ";", "\\", "<!--", "-->", "😀", "é", " ",
  "-", ".", "@", "_", '<Card of="places" pick="moda"/>', "<Text>", "</Text>", "<Stack>", "</Stack>", "<Code>", "</Code>", '{"a":1}', "{[1,2]}", "true", "null", " flag", ' k="v"', " k='v'", " k=v", " k={1}",
];

export default function ({ call, fixture }) {
  const both = (family, src) => {
    call(family, "parseMarkup", src);
    call(family, "parsePartial", src);
  };
  for (const src of CASES) both("markup", src);
  for (const depth of [7, 8, 9, 40, 300]) {
    both("markup", `${"<Stack>".repeat(depth)}<Text>deep</Text>${"</Stack>".repeat(depth)}`);
    both("markup", "<Stack>".repeat(depth));
  }

  for (const doc of [EDGE, fixture("trip").ui]) {
    for (let cut = 0; cut <= doc.length; cut++) {
      const prefix = doc.slice(0, cut);
      if (prefix.isWellFormed()) both("markup-sweep", prefix);
    }
  }

  const rng = prng(0x6d61726b);
  for (let i = 0; i < 400; i++) {
    let src = "";
    for (let n = 1 + rng.int(30); n > 0; n--) src += rng.pick(FRAGMENTS);
    both("markup-fuzz", src);
  }
}
