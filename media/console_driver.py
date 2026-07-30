"""Interactive Python session driver for the Plot Panel console.

Standard library only: the extension ships zero runtime dependencies, and this
file is spawned as-is from the packaged .vsix.

Protocol, one JSON object per line in each direction, so neither side needs a
parser beyond json:

  in   {"id": 1, "op": "exec", "code": "x = 1"}
       {"id": 2, "op": "vars"}
       {"id": 3, "op": "children", "expression": "df"}
       {"id": 4, "op": "reset"}
  out  {"t": "ready", "version": "3.11.11", "executable": "/usr/bin/python3"}
       {"t": "out", "id": 1, "s": "hello\\n"}
       {"t": "err", "id": 1, "s": "Traceback ...\\n"}
       {"t": "result", "id": 1, "s": "42"}
       {"t": "done", "id": 1, "more": false}
       {"t": "vars", "id": 2, "data": [...]}
       {"t": "children", "id": 3, "data": [...]}

Why a driver rather than `python -i`: with piped stdin the interpreter writes
its prompts to stderr without a trailing newline, and a bare expression's
value is indistinguishable from anything the code printed. Here the framing
carries an execution id, separates results from output, and reports the
continuation state explicitly.

`vars` and `children` reuse the JSON shapes the extension already parses for
Jupyter kernels, so the same TypeScript decoding path serves both sources.
Unlike a Jupyter kernel, this one reports functions and classes too, and
`children` re-reads live objects, so expansion has no depth limit.
"""

import builtins
import codeop
import io
import json
import keyword
import os
import re
import rlcompleter
import sys
import threading
import traceback

_REAL_STDOUT = sys.stdout
_REAL_STDIN = sys.stdin
_WRITE_LOCK = threading.Lock()

#: Execution the frames currently belong to, so output can be attributed.
_ACTIVE_ID = 0

CHILD_CAP = 100
VALUE_CAP = 65536
CHILD_VALUE_CAP = 120

#: Names the driver itself binds; never reported as user variables. "_" is
#: the last expression result, which the REPL rebinds constantly.
_INTERNAL = {"_", "__builtins__", "__name__", "__doc__", "__package__", "__loader__", "__spec__"}


def _emit(**frame):
    line = json.dumps(frame, default=str)
    with _WRITE_LOCK:
        _REAL_STDOUT.write(line + "\n")
        _REAL_STDOUT.flush()


class _FramedStream(io.TextIOBase):
    """Stands in for sys.stdout/sys.stderr and forwards writes as frames."""

    def __init__(self, kind):
        self._kind = kind

    def write(self, text):
        if text:
            _emit(t=self._kind, id=_ACTIVE_ID, s=text)
        return len(text)

    def writable(self):
        return True

    def isatty(self):
        return False

    def flush(self):
        pass


class _ClosedStdin(io.TextIOBase):
    """User code must not be able to eat the protocol on stdin."""

    def readable(self):
        return True

    def read(self, size=None):
        return ""

    def readline(self, size=None):
        return ""

    def isatty(self):
        return False


def _type_name(obj):
    try:
        return type(obj).__module__ + "." + type(obj).__name__
    except Exception:
        return "?"


def _repr(obj, cap):
    try:
        text = repr(obj)
    except Exception:
        return "<unrepresentable>"
    if len(text) > cap:
        return text[: cap - 3] + "..."
    return text


def _flat_repr(obj, cap):
    try:
        text = " ".join(repr(obj).split())
    except Exception:
        return "<unrepresentable>"
    if len(text) > cap:
        return text[: cap - 3] + "..."
    return text


def _indexed_count(obj):
    """Element count for the containers the view sizes by length."""
    name = type(obj).__name__
    if isinstance(obj, (list, tuple, set, frozenset, dict)) or name in ("Series", "ndarray", "Index"):
        try:
            return int(len(obj))
        except Exception:
            return 0
    return 0


def _has_named_children(obj):
    name = type(obj).__name__
    if isinstance(obj, dict) or name in ("DataFrame",):
        return True
    try:
        return bool(vars(obj))
    except Exception:
        return False


def _has_children(obj):
    if isinstance(obj, (dict, list, tuple, set, frozenset)):
        return len(obj) > 0
    if type(obj).__name__ in ("DataFrame", "Series", "ndarray", "Index"):
        try:
            return len(obj) > 0
        except Exception:
            return False
    return _has_named_children(obj)


def _describe_child(name, expression, child):
    return {
        "name": str(name),
        "expression": expression,
        "type": _type_name(child),
        "value": _flat_repr(child, CHILD_VALUE_CAP),
        "hasChildren": bool(_has_children(child)),
    }


def _make_shell():
    """
    An IPython shell when the environment has one, so magics work: %run
    (including on .ipynb files), %timeit, !shell and the rest are what a data
    science console is expected to offer, and reimplementing them would be
    both large and worse. Falls back to plain exec when IPython is absent.
    """
    try:
        from IPython.core.interactiveshell import InteractiveShell
    except Exception:
        return None
    try:
        shell = InteractiveShell.instance()
        # IPython prints "Out[N]: ..." itself; results travel as their own
        # frames here, so silence its display hook rather than double up.
        shell.displayhook.write_output_prompt = lambda: None
        shell.displayhook.write_format_data = lambda data, metadata=None: None
        # Tracebacks default to stdout dressed in ANSI colours. Take the same
        # hook ipykernel uses so they arrive as error frames instead, and drop
        # the colours: there is no terminal here to interpret the escapes.
        for formatter in (shell.InteractiveTB, shell.SyntaxTB):
            for method, argument in (("set_theme_name", "nocolor"), ("set_colors", "NoColor")):
                try:
                    getattr(formatter, method)(argument)
                    break
                except Exception:
                    continue

        def show_traceback(etype, evalue, stb):
            _emit(t="err", id=_ACTIVE_ID, s="\n".join(stb) + "\n")

        shell._showtraceback = show_traceback

        # matplotlib asks IPython to start a GUI event loop as soon as a
        # figure is created, and a bare InteractiveShell raises
        # NotImplementedError for that. There is no GUI here — figures are
        # captured, not windowed — so accepting and ignoring the request is
        # both correct and what keeps %run working on plotting notebooks.
        shell.enable_gui = lambda gui=None: None
        return shell
    except Exception:
        return None


class Session:
    def __init__(self):
        self.shell = _make_shell()
        if self.shell is not None:
            self.namespace = self.shell.user_ns
            self.hidden = set(getattr(self.shell, "user_ns_hidden", {}))
            self.hidden.update(["In", "Out", "get_ipython", "exit", "quit", "open"])
        else:
            self.namespace = {"__name__": "__console__", "__doc__": None}
            self.hidden = set()
        self.buffer = []
        self.compile = codeop.CommandCompiler()

    @property
    def globals(self):
        return self.namespace

    # -- execution --------------------------------------------------------

    def execute(self, source):
        """Feed one line. Returns True when more input is expected."""
        self.buffer.append(source)
        joined = "\n".join(self.buffer)
        if self.shell is not None:
            return self._execute_ipython(joined)
        try:
            code = self.compile(joined, "<console>", "single")
        except (OverflowError, SyntaxError, ValueError):
            self.buffer = []
            _emit(t="err", id=_ACTIVE_ID, s=traceback.format_exc(limit=0))
            return False
        if code is None:
            return True
        self.buffer = []
        self._run(code)
        return False

    def _execute_ipython(self, joined):
        shell = self.shell
        if shell is None:
            return False
        try:
            status, _indent = shell.check_complete(joined)
        except Exception:
            status = "complete"
        if status == "incomplete":
            return True
        self.buffer = []
        try:
            # IPython reports syntax errors and tracebacks through
            # showtraceback(), which writes to the redirected stderr.
            result = shell.run_cell(joined, store_history=True)
        except KeyboardInterrupt:
            _emit(t="err", id=_ACTIVE_ID, s="\nKeyboardInterrupt\n")
            return False
        except BaseException:
            _emit(t="err", id=_ACTIVE_ID, s=traceback.format_exc())
            return False
        value = getattr(result, "result", None)
        if value is not None and getattr(result, "success", False):
            _emit(t="result", id=_ACTIVE_ID, s=_repr(value, VALUE_CAP))
        return False

    def _run(self, code):
        def displayhook(value):
            if value is None:
                return
            self.globals["_"] = value
            _emit(t="result", id=_ACTIVE_ID, s=_repr(value, VALUE_CAP))

        previous = sys.displayhook
        sys.displayhook = displayhook
        try:
            exec(code, self.globals)
        except SystemExit:
            raise
        except KeyboardInterrupt:
            _emit(t="err", id=_ACTIVE_ID, s="\nKeyboardInterrupt\n")
        except BaseException:
            _emit(t="err", id=_ACTIVE_ID, s=self._format_exception())
        finally:
            sys.displayhook = previous

    def _format_exception(self):
        kind, value, tb = sys.exc_info()
        # Drop this frame so the traceback starts in the user's code.
        return "".join(traceback.format_exception(kind, value, tb.tb_next if tb else None))

    # -- introspection ----------------------------------------------------

    def complete(self, line, position):
        """
        Completions for the token ending at `position`, from the live
        namespace — which beats any static analysis in a REPL, since it knows
        what the objects actually are. Returns where the token starts so the
        caller can replace exactly that much text.
        """
        prefix = line[:position]
        start = len(prefix)
        while start > 0 and (prefix[start - 1].isalnum() or prefix[start - 1] in "_."):
            start -= 1
        token = prefix[start:]

        # A magic is only a magic at the start of the line.
        magic = re.match(r"\s*(%{1,2}[A-Za-z_]*)$", prefix)
        if magic is not None and self.shell is not None:
            found = self._magics(magic.group(1))
            return {
                "start": prefix.rindex(magic.group(1)),
                "items": [{"label": name, "kind": "magic", "detail": ""} for name in found],
            }

        # Inside quotes, or right after %run/%cd/open(, a path is what is
        # wanted — not a Python name.
        paths = self._paths(prefix)
        if paths is not None:
            return paths

        items = []
        seen = set()
        try:
            completer = rlcompleter.Completer(self.namespace)
            for index in range(200):
                match = completer.complete(token, index)
                if match is None:
                    break
                # rlcompleter marks callables with a trailing "(".
                match = match.rstrip("(")
                if match and match not in seen:
                    seen.add(match)
                    items.append(match)
        except Exception:
            pass
        if "." not in token:
            for word in keyword.kwlist:
                if word.startswith(token) and word not in seen:
                    seen.add(word)
                    items.append(word)
        items.sort(key=lambda name: (name.startswith("_"), name.lower()))
        return {"start": start, "items": [self._describe(name) for name in items[:100]]}

    def _describe(self, name):
        """Label plus the kind and type the view shows beside it."""
        target = self.namespace
        leaf = name
        if "." in name:
            head, _, leaf = name.rpartition(".")
            try:
                target = eval(head, self.namespace)
            except Exception:
                return {"label": name, "kind": "value", "detail": ""}
        try:
            if isinstance(target, dict):
                value = target[leaf] if leaf in target else getattr(builtins, leaf)
            else:
                value = getattr(target, leaf)
        except Exception:
            return {
                "label": name,
                "kind": "keyword" if name in keyword.kwlist else "value",
                "detail": "",
            }
        try:
            type_name = type(value).__name__
        except Exception:
            type_name = ""
        if isinstance(value, type):
            kind = "class"
        elif callable(value):
            kind = "function"
        elif type(value).__name__ == "module":
            kind = "module"
        else:
            kind = "value"
        return {"label": name, "kind": kind, "detail": type_name}

    PATH_TRIGGERS = ("%run", "%cd", "%load", "%pycat", "!cat", "!ls", "open(")

    def _paths(self, prefix):
        """Filenames when the line is clearly asking for one; else None."""
        stripped = prefix.lstrip()
        quote = max(stripped.rfind("'"), stripped.rfind('"'))
        wants_path = any(stripped.startswith(trigger) for trigger in self.PATH_TRIGGERS)
        if not wants_path and quote == -1:
            return None
        cut = quote + 1 if quote != -1 else max(
            (len(prefix) - len(stripped)) + len(trigger)
            for trigger in self.PATH_TRIGGERS
            if stripped.startswith(trigger)
        )
        partial = prefix[cut:].lstrip() if quote == -1 else prefix[cut:]
        start = len(prefix) - len(partial)
        directory, _, stem = partial.rpartition("/")
        base = directory if directory else "."
        try:
            entries = sorted(os.listdir(base))
        except Exception:
            return None
        items = []
        for entry in entries:
            if entry.startswith(".") and not stem.startswith("."):
                continue
            if not entry.startswith(stem):
                continue
            full = os.path.join(base, entry)
            is_directory = os.path.isdir(full)
            items.append(
                {
                    "label": (directory + "/" if directory else "") + entry + ("/" if is_directory else ""),
                    "kind": "folder" if is_directory else "file",
                    "detail": "",
                }
            )
        return {"start": start, "items": items[:100]}

    def _magics(self, token):
        shell = self.shell
        if shell is None:
            return []
        bare = token.lstrip("%")
        try:
            names = list(shell.magics_manager.magics.get("line", {}))
            names += list(shell.magics_manager.magics.get("cell", {}))
        except Exception:
            return []
        found = sorted({"%" + name for name in names if name.startswith(bare)})
        return found[:100]

    def list_variables(self):
        out = []
        for name, obj in list(self.globals.items()):
            # Leading underscores are private by convention, and IPython fills
            # the namespace with _, __, _i, _i1, _12 … input/output history.
            if name in _INTERNAL or name in self.hidden or name.startswith("_"):
                continue
            if type(obj).__name__ == "module":
                continue
            try:
                out.append(
                    {
                        "name": name,
                        "expression": name,
                        "type": _type_name(obj),
                        "value": _repr(obj, VALUE_CAP),
                        "hasNamedChildren": bool(_has_named_children(obj)),
                        "indexedChildrenCount": _indexed_count(obj),
                    }
                )
            except Exception:
                continue
        return out

    def children(self, expression):
        try:
            obj = eval(expression, self.globals)
        except Exception:
            return []
        out = []
        name = type(obj).__name__
        try:
            if name == "DataFrame":
                for column in list(obj.columns)[:CHILD_CAP]:
                    try:
                        out.append(
                            _describe_child(
                                column, expression + "[" + repr(column) + "]", obj[column]
                            )
                        )
                    except Exception:
                        pass
            elif name in ("Series", "Index"):
                for position in range(min(len(obj), CHILD_CAP)):
                    try:
                        label = obj.index[position] if name == "Series" else position
                        out.append(
                            _describe_child(
                                label,
                                expression + ".iloc[" + str(position) + "]",
                                obj.iloc[position] if name == "Series" else obj[position],
                            )
                        )
                    except Exception:
                        pass
            elif name == "ndarray":
                for position in range(min(len(obj), CHILD_CAP)):
                    try:
                        out.append(
                            _describe_child(
                                position, expression + "[" + str(position) + "]", obj[position]
                            )
                        )
                    except Exception:
                        pass
            elif isinstance(obj, dict):
                for key in list(obj.keys())[:CHILD_CAP]:
                    try:
                        out.append(
                            _describe_child(key, expression + "[" + repr(key) + "]", obj[key])
                        )
                    except Exception:
                        pass
            elif isinstance(obj, (list, tuple)):
                for position, item in enumerate(obj[:CHILD_CAP]):
                    out.append(
                        _describe_child(position, expression + "[" + str(position) + "]", item)
                    )
            elif isinstance(obj, (set, frozenset)):
                for position, item in enumerate(list(obj)[:CHILD_CAP]):
                    out.append(
                        _describe_child(
                            position, "list(" + expression + ")[" + str(position) + "]", item
                        )
                    )
            else:
                # Attributes, skipping callables: expansion may run property
                # getters, so every access is guarded — the standard trade-off
                # for any variable inspector.
                for attribute in [n for n in dir(obj) if not n.startswith("_")][:CHILD_CAP]:
                    try:
                        child = getattr(obj, attribute)
                    except Exception:
                        continue
                    if callable(child):
                        continue
                    out.append(
                        _describe_child(attribute, expression + "." + attribute, child)
                    )
        except Exception:
            pass
        return out


def main():
    global _ACTIVE_ID
    # Redirect first: IPython binds to the streams that exist when its shell
    # is built, and its tracebacks must travel as frames like everything else.
    sys.stdout = _FramedStream("out")
    sys.stderr = _FramedStream("err")
    sys.stdin = _ClosedStdin()
    session = Session()
    _emit(
        t="ready",
        version="%d.%d.%d" % sys.version_info[:3],
        executable=sys.executable,
        magics=session.shell is not None,
    )
    while True:
        try:
            line = _REAL_STDIN.readline()
        except KeyboardInterrupt:
            # A stray interrupt while idle is not an error.
            continue
        if not line:
            return
        try:
            request = json.loads(line)
        except ValueError:
            continue
        _ACTIVE_ID = request.get("id", 0)
        op = request.get("op")
        try:
            if op == "exec":
                more = session.execute(request.get("code", ""))
                _emit(t="done", id=_ACTIVE_ID, more=bool(more))
            elif op == "vars":
                _emit(t="vars", id=_ACTIVE_ID, data=session.list_variables())
            elif op == "children":
                _emit(
                    t="children",
                    id=_ACTIVE_ID,
                    data=session.children(request.get("expression", "")),
                )
            elif op == "complete":
                line = request.get("line", "")
                _emit(
                    t="complete",
                    id=_ACTIVE_ID,
                    **session.complete(line, request.get("position", len(line))),
                )
            elif op == "reset":
                session = Session()
                _emit(t="done", id=_ACTIVE_ID, more=False)
        except KeyboardInterrupt:
            _emit(t="err", id=_ACTIVE_ID, s="\nKeyboardInterrupt\n")
            _emit(t="done", id=_ACTIVE_ID, more=False)
        except Exception:
            _emit(t="err", id=_ACTIVE_ID, s=traceback.format_exc())
            _emit(t="done", id=_ACTIVE_ID, more=False)


if __name__ == "__main__":
    main()
