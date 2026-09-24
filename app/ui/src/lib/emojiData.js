// A curated emoji set for the project icon picker. Each category is a compact
// "emoji keywords" list (comma separated) so search can match by name without
// shipping a full Unicode database.

const RAW = [
  ["suggested", "Suggested", "🕘", "😄 smile happy,👍 thumbs up like,❤️ heart love,🎉 party tada,🚀 rocket launch,👀 eyes look,🙏 pray thanks,🔥 fire hot"],
  ["smileys", "Smileys and emotion", "😀",
    "😀 grin,😃 smiley,😄 smile,😁 beam,😆 laugh,😅 sweat,🤣 rofl,😂 joy tears,🙂 slight smile,🙃 upside down,🫠 melt,😉 wink,😊 blush,😇 angel halo,🥰 love hearts,😍 heart eyes,🤩 star struck,😘 kiss,😋 yum,😛 tongue,😜 wink tongue,🤪 zany,🤑 money,🤗 hug,🤔 think,🤐 zipper,😐 neutral,😏 smirk,😴 sleep,😎 cool sunglasses,🤓 nerd,🧐 monocle,😮 wow,😢 cry,😭 sob,😡 angry,🤯 mind blown,🥳 party,🥶 cold,🤖 robot,👻 ghost,💀 skull,👽 alien,😺 cat smile"],
  ["people", "People and body", "👋",
    "👋 wave hand,🤚 raised back,✋ hand,🖖 vulcan,👌 ok,🤌 pinched,✌️ victory peace,🤞 crossed fingers,🤟 love you,🤘 rock,👈 left,👉 right,👆 up,👇 down,☝️ point,👍 thumbs up,👎 thumbs down,✊ fist,👊 punch,👏 clap,🙌 raise hands,🤝 handshake,🙏 pray,💪 muscle strong,🧠 brain,👀 eyes,👤 user person,👥 users team,🧑‍💻 developer coder,🧑‍🎨 artist,🧑‍🔬 scientist,🧑‍🚀 astronaut,🥷 ninja,🧙 wizard"],
  ["nature", "Animals and nature", "🐶",
    "🐶 dog,🐱 cat,🐭 mouse,🐰 rabbit,🦊 fox,🐻 bear,🐼 panda,🐨 koala,🐯 tiger,🦁 lion,🐮 cow,🐷 pig,🐸 frog,🐵 monkey,🐔 chicken,🐧 penguin,🐦 bird,🦉 owl,🦄 unicorn,🐝 bee,🦋 butterfly,🐢 turtle,🐍 snake,🐙 octopus,🐬 dolphin,🐳 whale,🦈 shark,🦖 dinosaur,🌵 cactus,🌲 tree,🌿 herb,🍀 clover luck,🍁 leaf,🌸 blossom,🌻 sunflower,🌙 moon,⭐ star,☀️ sun,🌈 rainbow,❄️ snow,🌊 wave"],
  ["food", "Food and drink", "🍔",
    "🍎 apple,🍊 orange,🍋 lemon,🍌 banana,🍉 watermelon,🍇 grapes,🍓 strawberry,🍒 cherry,🍑 peach,🥑 avocado,🌶️ pepper hot,🥕 carrot,🌽 corn,🥐 croissant,🍞 bread,🧀 cheese,🍔 burger,🍟 fries,🍕 pizza,🌮 taco,🍣 sushi,🍜 ramen,🍩 donut,🍪 cookie,🎂 cake,🍫 chocolate,🍿 popcorn,☕ coffee,🍵 tea,🧋 boba,🍺 beer,🍷 wine"],
  ["travel", "Travel and places", "🚗",
    "🚗 car,🚕 taxi,🚌 bus,🏎️ race car,🚓 police,🚑 ambulance,🚜 tractor,🚲 bike,🛵 scooter,🚂 train,✈️ plane,🚁 helicopter,🚀 rocket,🛸 ufo,⛵ boat,🚢 ship,⚓ anchor,🗺️ map,🧭 compass,🏔️ mountain,🏕️ camping,🏖️ beach,🏝️ island,🏠 house home,🏢 office building,🏭 factory,🏰 castle,🗼 tower,🌉 bridge,🌃 night city,🎡 ferris wheel"],
  ["activities", "Activities", "⚽",
    "⚽ soccer football,🏀 basketball,🏈 american football,⚾ baseball,🎾 tennis,🏐 volleyball,🏓 ping pong,🥊 boxing,⛳ golf,🎯 target goal,🎮 game controller,🕹️ joystick,🎲 dice,🧩 puzzle,♟️ chess,🎨 art palette,🎭 theater,🎬 movie film,🎤 microphone,🎧 headphones,🎸 guitar,🎹 piano,🥁 drum,🏆 trophy,🥇 medal gold,🎟️ ticket,🎁 gift,🎈 balloon,🎉 party,✨ sparkles"],
  ["objects", "Objects", "💡",
    "💡 idea bulb,🔦 flashlight,💻 laptop,🖥️ desktop,⌨️ keyboard,🖱️ mouse,📱 phone,⌚ watch,📷 camera,🎥 video,📺 tv,📡 satellite,🔋 battery,🔌 plug,💾 floppy save,💿 disc,📀 dvd,🗂️ dividers,📁 folder,📂 open folder,📄 page,📊 chart bar,📈 chart up,📉 chart down,📋 clipboard,📌 pin,📎 paperclip,✏️ pencil,🖊️ pen,📝 memo,📚 books,📓 notebook,🔒 lock,🔑 key,🔨 hammer,🛠️ tools,⚙️ gear settings,🧪 test tube,🔬 microscope,🔭 telescope,💊 pill,🧲 magnet,💰 money bag,💎 gem,📦 package box,✉️ envelope mail"],
  ["symbols", "Symbols", "❤️",
    "❤️ red heart,🧡 orange heart,💛 yellow heart,💚 green heart,💙 blue heart,💜 purple heart,🖤 black heart,🤍 white heart,💔 broken heart,💯 hundred,✅ check done,☑️ checkbox,✔️ tick,❌ cross,❗ exclamation,❓ question,⚠️ warning,🚫 prohibited,♻️ recycle,⚛️ atom,🔴 red circle,🟠 orange circle,🟡 yellow circle,🟢 green circle,🔵 blue circle,🟣 purple circle,⚫ black circle,⚪ white circle,🔶 diamond,🔷 blue diamond,➕ plus,➖ minus,♾️ infinity,🔁 repeat,⏳ hourglass,⏰ alarm,🔔 bell,💬 speech,💭 thought,🌀 cyclone"],
  ["flags", "Flags", "🏁",
    "🏁 checkered finish,🚩 red flag,🎌 crossed flags,🏴 black flag,🏳️ white flag,🏳️‍🌈 rainbow flag,🏴‍☠️ pirate,🇹🇷 turkey,🇺🇸 united states usa,🇬🇧 united kingdom uk,🇩🇪 germany,🇫🇷 france,🇪🇸 spain,🇮🇹 italy,🇳🇱 netherlands,🇯🇵 japan,🇰🇷 korea,🇨🇳 china,🇮🇳 india,🇧🇷 brazil,🇨🇦 canada,🇦🇺 australia,🇪🇺 european union"],
];

export const EMOJI_CATEGORIES = RAW.map(([id, label, icon, list]) => ({
  id,
  label,
  icon,
  items: list.split(",").map((entry) => {
    const space = entry.indexOf(" ");
    return { emoji: entry.slice(0, space), tags: entry.slice(space + 1) };
  }),
}));

export function searchEmoji(query) {
  const q = query.trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const c of EMOJI_CATEGORIES) {
    for (const item of c.items) {
      if (item.tags.includes(q) && !seen.has(item.emoji)) { seen.add(item.emoji); out.push(item); }
    }
  }
  return out;
}
