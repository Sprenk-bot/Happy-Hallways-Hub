const file = "hub-host/routes.ts";
let text = await Bun.file(file).text();
// Re-indent stray "  return true;" lines that sit at two-space indent inside a
// deeper block: match `^  return true;$` preceded by a line ending with `);` or `}` etc.
const lines = text.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === "  return true;") {
    // find previous non-empty line's indent
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    if (j >= 0) {
      const prev = lines[j];
      const prevIndent = prev.match(/^(\s*)/)![1];
      // Find enclosing block indent: look forward for the matching closer
      // Simplest: copy indent of the line after (if it's `}` at N spaces, use N+2)
      let k = i + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      let indent = "    ";
      if (k < lines.length) {
        const nextIndent = lines[k].match(/^(\s*)/)![1];
        if (lines[k].trim().startsWith("}")) {
          indent = nextIndent + "  ";
        } else {
          indent = nextIndent;
        }
      }
      lines[i] = indent + "return true;";
    }
  }
}
await Bun.write(file, lines.join("\n"));
console.log("done");
