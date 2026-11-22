const file = "hubconst file = "hub-host/routes.ts";
let text = await Bun.file(file).text();
// Remove now-unused narrowed actor declarations and unused destructured actor.
const lines = text.split("\n");
const out: string[] = [];
for (let line of lines) {
  if (/^\s*const actor = guardedActor\(context\);$/.test(line)) {
    continue;
  }
  line = line.replace(/(const \{[^}]*?)\bactor,\s*/, "$1");
  line = line.replace(/,\s*actor(\s*\} = context;)/, "$1");
  if (/^\s*\/\/ After each narrowed/.test(line)) continue;
  if (/text = text\.replace\(/.test(line) && /no-op safeguard/.test(text)) {
    continue;
  }
  out.push(line);
}
text = out.join("\n").replace(/[\s\S]*?^const file/m, "const file");
await Bun.write(file, text);
console.log("done");
