# claude-lint

A Claude Code plugin that formats and lints every file Claude edits, and reports
what it found in one line instead of a wall of text.

## What it does

After each `Edit` and `Write` the plugin runs the tools of the edited file's
language, synchronously, so the model learns about a problem before it makes the
next change:

| Language | Formatter | Linter |
| --- | --- | --- |
| Go | `gofmt -w` | `golangci-lint run --new-from-rev=HEAD` over the file's package, or `go vet` outside a module |
| Python | `ruff format` | `ruff check` |
| Java | `google-java-format -i` | — |

Every language listed in `CODE_EXTENSIONS` additionally gets a check on the
comments the session added: comments that restate the code, section-divider
banners, and blocks of five or more consecutive comment lines. A comment that
gives a reason — `because`, `so that`, `to avoid`, or anything after a colon —
is left alone.

A tool that is not on `PATH` is skipped, and its language with it.

Every finding reads `<path>:<line>:<column>: <what>`, the path relative to the
session's working directory, whichever tool found it.

When nothing is wrong, nothing is said — not to the person, not to the model.
Reformatting a file is silent too. When there are findings, the model receives
the full text as tool-result context. A folded run of calls gets one line under
it with the count:

```
2 lint issues in internal/api/service.go (ctrl+o to expand)
```

In the ctrl+o transcript each call's result row shows that count and the
findings themselves, in place of what the tool would otherwise report.

## Requirements

Claude Code with function hooks enabled:

```jsonc
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

The API is early access and may change between releases.

## Install

```sh
claude plugin marketplace add Conte777/claude-lint
claude plugin install lint@claude-lint
```

## Development

```sh
claude --plugin-dir plugins/lint          # load from disk, reloaded on save
claude plugin validate plugins/lint       # what the module hooks and calls
```

The plugin is typed against the declarations of the Claude Code build it runs
on, which Claude Code writes into `.claude-plugin/types/` each time it loads the
plugin with `--plugin-dir`. Regenerate them after an update:

```sh
cd plugins/lint && claude -p "/cost" --plugin-dir . && tsc -p tsconfig.json
```
