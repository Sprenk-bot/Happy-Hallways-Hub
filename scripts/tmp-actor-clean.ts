const file = "hub-host/routes.ts";
let text = await Bun.file(file).text();
const lines = text.split("\n");
// Replace remaining bare `actor` argument usages with guardedActor(context),
// except destructure lines and declarations.
const out = lines.map((line) => {
  if (/const \{.*\} = context;/.test(line)) return line;
  if (/const actor =/.test(line)) return line;
  if (/actor:/.test(line)) return line;
  if (/guardedActor/.test(line)) return line;
  if (/requireStaff\(actor\)|requireTic\(actor\)/.test(line)) return line;
  return line.replace(/(^|[^.\w])actor([^.\w]|$)/g, (m, a, b) =>
    /["'`]/.test(a) || /["'`]/.test(b) ? m : `${a}guardedActor(context)${b}`,
  );
});
// Fix doubled insertions on lines already containing it.
const fixed = out.map((l) =>
  l.replace(/guardedActor\(context\)guardedActor\(context\)/g, "guardedActor(context)")
   .replace(/guardedActor\(context\)\.actor/g, "guardedActor(context)"),
);
await Bun.write(file, fixed.join("\n"));
console.log("done");
