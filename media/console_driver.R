## Interactive R session driver for the Plot Panel console.
##
## Speaks the same line-framed JSON protocol as console_driver.py, so the
## TypeScript side decodes both the same way. Base R only: the extension
## ships no dependencies and cannot assume a package is installed, which is
## why the little JSON reader and writer below are hand-rolled rather than
## taken from jsonlite.
##
##   in   {"id":1,"op":"exec","code":"x <- 1"}
##        {"id":2,"op":"vars"} / {"op":"children","expression":"df"}
##        {"op":"complete","line":"me","position":2}
##   out  {"t":"ready","version":"4.6.1"}
##        {"t":"out"|"err"|"result","id":1,"s":"…"}
##        {"t":"done","id":1,"more":false}
##        {"t":"vars"|"children","id":2,"data":[…]}
##        {"t":"complete","id":3,"start":0,"items":[…]}

CHILD_CAP <- 100L
VALUE_CAP <- 4096L
CHILD_VALUE_CAP <- 120L

ENV <- new.env(parent = globalenv())
BUFFER <- character(0)
ACTIVE_ID <- 0L

## ---------------------------------------------------------------- writing

json_escape <- function(text) {
  text <- gsub("\\", "\\\\", text, fixed = TRUE)
  text <- gsub("\"", "\\\"", text, fixed = TRUE)
  text <- gsub("\n", "\\n", text, fixed = TRUE)
  text <- gsub("\r", "\\r", text, fixed = TRUE)
  text <- gsub("\t", "\\t", text, fixed = TRUE)
  ## Any remaining control character would make the line unparseable.
  gsub("[\001-\037]", " ", text)
}

json_string <- function(text) paste0("\"", json_escape(text), "\"")

json_value <- function(value) {
  if (is.null(value)) {
    "null"
  } else if (is.logical(value) && length(value) == 1L) {
    if (isTRUE(value)) "true" else "false"
  } else if (is.numeric(value) && length(value) == 1L) {
    format(value, scientific = FALSE)
  } else if (is.list(value)) {
    if (!is.null(names(value))) json_object(value) else json_array(value)
  } else if (is.character(value) && length(value) == 1L) {
    json_string(value)
  } else {
    json_array(as.list(value))
  }
}

json_object <- function(fields) {
  parts <- vapply(
    names(fields),
    function(key) paste0(json_string(key), ":", json_value(fields[[key]])),
    character(1)
  )
  paste0("{", paste(parts, collapse = ","), "}")
}

json_array <- function(items) {
  if (length(items) == 0L) {
    return("[]")
  }
  paste0("[", paste(vapply(items, json_value, character(1)), collapse = ","), "]")
}

emit <- function(fields) {
  cat(json_object(fields), "\n", sep = "", file = stdout())
  flush(stdout())
}

emit_text <- function(kind, text) {
  if (length(text) == 0L) return(invisible(NULL))
  joined <- paste(text, collapse = "\n")
  if (nchar(joined) == 0L) return(invisible(NULL))
  emit(list(t = kind, id = ACTIVE_ID, s = paste0(joined, "\n")))
}

## ---------------------------------------------------------------- reading

## Minimal reader for the flat objects this protocol sends: string, number,
## boolean and null values only. Anything else is not part of the contract.
parse_request <- function(line) {
  chars <- strsplit(line, "")[[1]]
  position <- 1L
  size <- length(chars)
  skip_space <- function() {
    while (position <= size && chars[position] %in% c(" ", "\t", "\n", "\r")) {
      position <<- position + 1L
    }
  }
  read_string <- function() {
    position <<- position + 1L # opening quote
    out <- character(0)
    while (position <= size) {
      char <- chars[position]
      if (char == "\\" && position < size) {
        escaped <- chars[position + 1L]
        out <- c(out, switch(escaped,
          "n" = "\n", "t" = "\t", "r" = "\r", "b" = "\b", "f" = "\f",
          "u" = {
            code <- paste(chars[(position + 2L):(position + 5L)], collapse = "")
            position <<- position + 4L
            intToUtf8(strtoi(code, 16L))
          },
          escaped
        ))
        position <<- position + 2L
        next
      }
      if (char == "\"") {
        position <<- position + 1L
        break
      }
      out <- c(out, char)
      position <<- position + 1L
    }
    paste(out, collapse = "")
  }
  read_literal <- function() {
    start <- position
    while (position <= size && !(chars[position] %in% c(",", "}", " "))) {
      position <<- position + 1L
    }
    text <- paste(chars[start:(position - 1L)], collapse = "")
    if (text == "true") TRUE else if (text == "false") FALSE
    else if (text == "null") NULL else suppressWarnings(as.numeric(text))
  }
  result <- list()
  skip_space()
  if (position <= size && chars[position] == "{") position <- position + 1L
  repeat {
    skip_space()
    if (position > size || chars[position] == "}") break
    if (chars[position] == ",") {
      position <- position + 1L
      next
    }
    key <- read_string()
    skip_space()
    if (position <= size && chars[position] == ":") position <- position + 1L
    skip_space()
    value <- if (position <= size && chars[position] == "\"") read_string() else read_literal()
    result[[key]] <- value
  }
  result
}

## ------------------------------------------------------------- inspection

type_of <- function(object) {
  classes <- class(object)
  if (length(classes) == 0L) typeof(object) else classes[[1]]
}

repr_of <- function(object, cap) {
  text <- tryCatch(
    paste(utils::capture.output(print(object)), collapse = "\n"),
    error = function(e) "<unrepresentable>"
  )
  if (nchar(text) > cap) paste0(substr(text, 1L, cap - 3L), "...") else text
}

count_of <- function(object) {
  if (is.data.frame(object)) return(nrow(object) * ncol(object))
  if (is.list(object) || is.vector(object)) return(length(object))
  0L
}

has_children <- function(object) {
  is.data.frame(object) || is.list(object) ||
    (is.vector(object) && length(object) > 1L) || isS4(object)
}

list_variables <- function() {
  names_found <- sort(ls(ENV, all.names = FALSE))
  lapply(names_found, function(name) {
    object <- tryCatch(get(name, envir = ENV), error = function(e) NULL)
    list(
      name = name,
      expression = name,
      type = type_of(object),
      value = repr_of(object, VALUE_CAP),
      hasNamedChildren = is.data.frame(object) || (is.list(object) && !is.null(names(object))),
      indexedChildrenCount = count_of(object)
    )
  })
}

describe_child <- function(name, expression, child) {
  list(
    name = as.character(name),
    expression = expression,
    type = type_of(child),
    value = gsub("\\s+", " ", repr_of(child, CHILD_VALUE_CAP)),
    hasChildren = has_children(child)
  )
}

children_of <- function(expression) {
  object <- tryCatch(eval(parse(text = expression), ENV), error = function(e) NULL)
  if (is.null(object)) return(list())
  out <- list()
  if (is.data.frame(object) || (is.list(object) && !is.null(names(object)))) {
    keys <- utils::head(names(object), CHILD_CAP)
    for (key in keys) {
      child <- tryCatch(object[[key]], error = function(e) NULL)
      out[[length(out) + 1L]] <- describe_child(
        key, paste0(expression, "[[\"", key, "\"]]"), child
      )
    }
  } else if (is.list(object) || is.vector(object)) {
    total <- min(length(object), CHILD_CAP)
    if (total > 0L) {
      for (index in seq_len(total)) {
        child <- tryCatch(object[[index]], error = function(e) NULL)
        out[[length(out) + 1L]] <- describe_child(
          index, paste0(expression, "[[", index, "]]"), child
        )
      }
    }
  } else if (isS4(object)) {
    for (slot in utils::head(methods::slotNames(object), CHILD_CAP)) {
      child <- tryCatch(methods::slot(object, slot), error = function(e) NULL)
      out[[length(out) + 1L]] <- describe_child(
        slot, paste0(expression, "@", slot), child
      )
    }
  }
  out
}

## Completions from the live session: names in scope, and the members of an
## object when completing after `$`.
complete_at <- function(line, position) {
  prefix <- substr(line, 1L, position)
  start <- position
  is_token_char <- function(char) grepl("[A-Za-z0-9._$@:]", char)
  while (start > 0L && is_token_char(substr(prefix, start, start))) {
    start <- start - 1L
  }
  token <- substr(prefix, start + 1L, position)
  items <- character(0)
  dollar <- regexpr("\\$[^$]*$", token)
  if (dollar > 0L) {
    base_expression <- substr(token, 1L, dollar - 1L)
    partial <- substr(token, dollar + 1L, nchar(token))
    object <- tryCatch(eval(parse(text = base_expression), ENV), error = function(e) NULL)
    members <- if (is.null(object)) character(0) else names(object)
    matches <- members[startsWith(members, partial)]
    items <- paste0(base_expression, "$", matches)
  } else {
    candidates <- unique(c(ls(ENV, all.names = FALSE), unlist(lapply(search(), ls))))
    items <- sort(candidates[startsWith(candidates, token)])
  }
  list(start = start, items = utils::head(as.list(items), CHILD_CAP))
}

## -------------------------------------------------------------- execution

## Evaluate every expression of a block, keeping only the last one's value.
run_block <- function(code) {
  BUFFER <<- c(BUFFER, code)
  joined <- paste(BUFFER, collapse = "\n")
  parsed <- tryCatch(parse(text = joined), error = function(e) e)
  if (inherits(parsed, "error")) {
    message_text <- conditionMessage(parsed)
    if (grepl("unexpected end of input", message_text, fixed = TRUE) ||
        grepl("unexpected INCOMPLETE_STRING", message_text, fixed = TRUE)) {
      return(TRUE)
    }
    BUFFER <<- character(0)
    emit_text("err", message_text)
    return(FALSE)
  }
  BUFFER <<- character(0)
  if (length(parsed) == 0L) return(FALSE)
  for (index in seq_along(parsed)) {
    captured <- character(0)
    ## Diagnostics are collected rather than emitted here: a sink is active,
    ## so anything written now would land inside the captured output instead
    ## of on the protocol stream.
    pending <- character(0)
    connection <- textConnection("captured", "w", local = TRUE)
    sink(connection)
    outcome <- tryCatch(
      withCallingHandlers(
        withVisible(eval(parsed[[index]], ENV)),
        message = function(m) {
          pending <<- c(pending, sub("\n$", "", conditionMessage(m)))
          invokeRestart("muffleMessage")
        },
        warning = function(w) {
          pending <<- c(pending, paste0("Warning: ", conditionMessage(w)))
          invokeRestart("muffleWarning")
        }
      ),
      error = function(e) {
        pending <<- c(pending, paste0("Error: ", conditionMessage(e)))
        NULL
      },
      interrupt = function(i) {
        pending <<- c(pending, "Interrupted")
        NULL
      }
    )
    sink()
    close(connection)
    emit_text("out", captured)
    emit_text("err", pending)
    if (!is.null(outcome) && isTRUE(outcome$visible)) {
      emit_text("result", repr_of(outcome$value, VALUE_CAP))
    }
  }
  FALSE
}

## ------------------------------------------------------------------- main

main <- function() {
  emit(list(
    t = "ready",
    version = paste(R.version$major, R.version$minor, sep = "."),
    executable = file.path(R.home("bin"), "R"),
    magics = FALSE
  ))
  input <- file("stdin")
  open(input, blocking = TRUE)
  repeat {
    line <- tryCatch(readLines(input, n = 1L, warn = FALSE), interrupt = function(i) character(0))
    if (length(line) == 0L || is.na(line[[1]])) break
    if (nchar(line[[1]]) == 0L) next
    request <- tryCatch(parse_request(line[[1]]), error = function(e) NULL)
    if (is.null(request)) next
    ACTIVE_ID <<- if (is.null(request$id)) 0L else as.integer(request$id)
    operation <- request$op
    if (is.null(operation)) next
    if (operation == "exec") {
      more <- run_block(if (is.null(request$code)) "" else request$code)
      emit(list(t = "done", id = ACTIVE_ID, more = more))
    } else if (operation == "vars") {
      emit(list(t = "vars", id = ACTIVE_ID, data = list_variables()))
    } else if (operation == "children") {
      emit(list(
        t = "children", id = ACTIVE_ID,
        data = children_of(if (is.null(request$expression)) "" else request$expression)
      ))
    } else if (operation == "complete") {
      line_text <- if (is.null(request$line)) "" else request$line
      found <- complete_at(
        line_text,
        if (is.null(request$position)) nchar(line_text) else as.integer(request$position)
      )
      emit(list(t = "complete", id = ACTIVE_ID, start = found$start, items = found$items))
    } else if (operation == "reset") {
      ENV <<- new.env(parent = globalenv())
      BUFFER <<- character(0)
      emit(list(t = "done", id = ACTIVE_ID, more = FALSE))
    }
  }
}

main()
