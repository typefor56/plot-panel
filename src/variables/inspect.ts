/**
 * Kernel-side inspection protocol for expandable variables (children of a
 * DataFrame, dict, sequence or object). Pure module: it only builds the
 * Python snippet and parses its reply; executing it is the adapter's job.
 *
 * The snippet evaluates one expression in the kernel globals and prints a
 * single sentinel-prefixed JSON line describing its children. Child
 * expressions are built Python-side (repr-quoted keys), so expanding to any
 * depth is just re-running the snippet with a child's expression. The target
 * expression is double-encoded — a JSON string literal is a valid Python
 * string literal, and its payload is decoded with json.loads — so odd
 * variable or column names cannot break the quoting.
 *
 * Every attribute/item access is wrapped in try/except: like any variable
 * inspector, expansion may execute user property getters, and those may
 * throw. Children are capped at 100 per level.
 */

export interface ChildVariable {
  readonly name: string;
  readonly expression: string;
  readonly type: string;
  readonly value: string;
  readonly hasChildren: boolean;
}

/** Printed by the snippet immediately before the JSON payload. */
export const INSPECT_SENTINEL = '__PLOT_PANEL_VARS__:';

const CHILD_CAP = 100;

export function buildInspectCode(expression: string): string {
  // Outer stringify makes a Python string literal; inner one the JSON payload.
  const encoded = JSON.stringify(JSON.stringify(expression));
  return `def __plot_panel_inspect__():
    import json
    target = json.loads(${encoded})
    sentinel = "__PLOT_PANEL_" + "VARS__:"
    try:
        obj = eval(target, globals())
    except Exception:
        print(sentinel + "[]")
        return
    out = []
    def describe(name, expr, child):
        try:
            t = type(child).__module__ + "." + type(child).__name__
        except Exception:
            t = "?"
        try:
            v = " ".join(repr(child).split())
            if len(v) > 120:
                v = v[:117] + "..."
        except Exception:
            v = "<unrepresentable>"
        try:
            has = isinstance(child, (dict, list, tuple, set)) or type(child).__name__ in ("DataFrame", "Series", "ndarray") or (hasattr(child, "__dict__") and bool(vars(child)))
        except Exception:
            has = False
        out.append({"name": str(name), "expression": expr, "type": t, "value": v, "hasChildren": bool(has)})
    tname = type(obj).__name__
    try:
        if tname == "DataFrame":
            for col in list(obj.columns)[:${CHILD_CAP}]:
                try:
                    describe(col, target + "[" + repr(col) + "]", obj[col])
                except Exception:
                    pass
        elif tname in ("Series", "ndarray"):
            for i in range(min(len(obj), ${CHILD_CAP})):
                try:
                    describe(i, target + "[" + str(i) + "]" if tname == "ndarray" else target + ".iloc[" + str(i) + "]", obj[i] if tname == "ndarray" else obj.iloc[i])
                except Exception:
                    pass
        elif isinstance(obj, dict):
            for key in list(obj.keys())[:${CHILD_CAP}]:
                try:
                    describe(key, target + "[" + repr(key) + "]", obj[key])
                except Exception:
                    pass
        elif isinstance(obj, (list, tuple)):
            for i, item in enumerate(obj[:${CHILD_CAP}]):
                describe(i, target + "[" + str(i) + "]", item)
        elif isinstance(obj, set):
            for i, item in enumerate(list(obj)[:${CHILD_CAP}]):
                describe(i, "list(" + target + ")[" + str(i) + "]", item)
        else:
            for n in [n for n in dir(obj) if not n.startswith("_")][:${CHILD_CAP}]:
                try:
                    child = getattr(obj, n)
                except Exception:
                    continue
                if callable(child):
                    continue
                describe(n, target + "." + n, child)
    except Exception:
        pass
    print(sentinel + json.dumps(out, default=str))

__plot_panel_inspect__()
del __plot_panel_inspect__
`;
}

function isChildVariable(value: unknown): value is ChildVariable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['expression'] === 'string' &&
    typeof record['type'] === 'string' &&
    typeof record['value'] === 'string' &&
    typeof record['hasChildren'] === 'boolean'
  );
}

/**
 * Extract the children from the kernel's text output. Returns undefined when
 * no well-formed sentinel line is present (kernel error, no output…);
 * individual malformed items are skipped.
 */
export function parseInspectReply(text: string): readonly ChildVariable[] | undefined {
  for (const line of text.split('\n')) {
    const at = line.indexOf(INSPECT_SENTINEL);
    if (at === -1) {
      continue;
    }
    const payload = line.slice(at + INSPECT_SENTINEL.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      return parsed.filter(isChildVariable);
    }
  }
  return undefined;
}
