/**
 * Is an exported workflow's ImageStep node something this node can actually show? (imagestep#460 / #458)
 *
 * n8n drops a parameter whose displayOptions do not match when it loads a workflow, without a word — so a template
 * written against an older description imports clean and quietly runs with defaults: `options.folder` after the
 * rename to `collection` (#347) put every output in the input's collection, `publish: true` on a node whose Store
 * Result is off is never read. The templates are how the node is found (PRD §6, n8n.io/workflows), so each one is held
 * to the description here: the templates this package ships (`test/templates.test.js`) and the recipes'
 * (`recipes/test/recipes.test.js`).
 *
 * Checked per ImageStep node: every parameter is a field the description shows for that node's values; an
 * `options` value is one of its static options (a `loadOptionsMethod` list is live, so any string passes); a
 * `collection` holds only its own option names; a `json` field parses. An expression (`=…`) passes as a value — it is
 * only known at run time.
 */
const NODE_TYPE = "n8n-nodes-imagestep.imageStep";

function isExpression(value) {
  return typeof value === "string" && value.startsWith("=");
}

/** The value a field has on this node: what the template sets, else the default of the field visible for it. */
function valueOf(name, params, properties, seen = new Set()) {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  if (seen.has(name)) return undefined;
  seen.add(name);
  const field = properties.find((p) => p.name === name && shows(p, params, properties, seen));
  return field?.default;
}

function shows(property, params, properties, seen = new Set()) {
  const show = property.displayOptions?.show || {};
  return Object.entries(show).every(([key, allowed]) => allowed.includes(valueOf(key, params, properties, new Set(seen))));
}

/** Problems with one exported workflow, as `"<node name>: <what>"` strings; empty when every ImageStep node is clean. */
function checkTemplate(template, properties) {
  const problems = [];
  for (const node of template.nodes || []) {
    if (node.type !== NODE_TYPE) continue;
    const params = node.parameters || {};
    for (const [name, value] of Object.entries(params)) {
      const field = properties.find((p) => p.name === name && shows(p, params, properties));
      if (!field) {
        problems.push(`${node.name}: "${name}" is not a field this node shows for these values`);
        continue;
      }
      if (isExpression(value)) continue;
      if (field.type === "options" && field.options && !field.typeOptions?.loadOptionsMethod) {
        const allowed = field.options.map((o) => o.value);
        if (!allowed.includes(value))
          problems.push(`${node.name}: "${name}" = ${JSON.stringify(value)} is not one of ${allowed.join(", ")}`);
      }
      if (field.type === "collection" && value && typeof value === "object") {
        const allowed = (field.options || []).map((o) => o.name);
        for (const key of Object.keys(value)) {
          if (!allowed.includes(key)) problems.push(`${node.name}: "${name}.${key}" is not an option (${allowed.join(", ")})`);
        }
      }
      if (field.type === "json" && typeof value === "string") {
        try {
          JSON.parse(value);
        } catch {
          problems.push(`${node.name}: "${name}" is not JSON`);
        }
      }
    }
  }
  return problems;
}

module.exports = { NODE_TYPE, checkTemplate };
