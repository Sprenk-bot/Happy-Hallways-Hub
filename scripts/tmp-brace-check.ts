const text = await Bun.file("hub-host/server.ts").text();
const lines = text.split("\n");
let depth = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  depth += opens - closes;
  if (i > 225 && i < 570 && depth <= 0) {
    console.log("line", i + 1, "depth", depth, "|", lines[i].trim().slice(0, 60));
  }
}
