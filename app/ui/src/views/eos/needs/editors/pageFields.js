// What of a page issue the reader may edit in place (05 gap 22), read from the
// contract of the issue's design: a text field it marks `edit` takes plain
// text within its length, and a list it marks `edit` is reordered or
// shortened down to its `min`. No React in it.

const TEXT = new Set(["text", "longtext"]);

// "lead.title" → "Lead title"; a list row's own fields drop the row number.
export function fieldLabel(path) {
  const words = path.split(".").filter((p) => !/^\d+$/.test(p)).join(" ").replace(/[-_]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Field";
}

// A row of a list, named by its first line of text.
function rowLabel(item, of, index) {
  for (const [name, ty] of Object.entries(of?.fields ?? {})) {
    if (TEXT.has(ty.type) && typeof item?.[name] === "string" && item[name].trim()) return item[name];
  }
  return `Item ${index + 1}`;
}

function walk(fields, data, prefix, out) {
  for (const [name, ty] of Object.entries(fields ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    const value = data?.[name];
    if (TEXT.has(ty.type) && ty.edit && typeof value === "string") {
      out.push({ kind: ty.type, path, label: fieldLabel(path), value, max: ty.max });
    } else if (ty.type === "object") {
      walk(ty.fields, value, path, out);
    } else if (ty.type === "list" && Array.isArray(value)) {
      const rows = value.map((item, index) => {
        const inner = [];
        if (ty.of?.type === "object") walk(ty.of.fields, item, `${path}.${index}`, inner);
        return { index, label: rowLabel(item, ty.of, index), fields: inner };
      });
      const editable = Boolean(ty.edit);
      if (editable || rows.some((r) => r.fields.length)) {
        out.push({ kind: "list", path, label: fieldLabel(path), min: ty.min ?? 0, editable, rows });
      }
    }
  }
}

// Every editable place of `data` under `contract`, in the contract's order.
export function editableFields(contract, data) {
  const out = [];
  if (contract?.type === "object") walk(contract.fields, data, "", out);
  return out;
}

// What is wrong with a text before it is sent, or null.
export function textProblem(field, text) {
  if (field.kind === "text" && text.includes("\n")) return "One line only.";
  if (field.max != null && [...text].length > field.max) return `At most ${field.max} characters.`;
  return null;
}
