import type { EngineInterface, Register } from "claude-code"

type Issue = { line: number; column: number; text: string }

type Report = { count: number; name: string; detail: string }

type RunResult = { exitCode: number; stdout: string; stderr: string }

type RunInit = { cwd?: string; timeoutMs?: number }

type AddedLine = { line: number; text: string }

const CODE_EXTENSIONS = new Set([
  ".go", ".py", ".java", ".kt", ".scala", ".rs", ".rb", ".php", ".swift",
  ".sh", ".bash", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx",
])

const REPORT_LIMIT = 64

const TEXT_LIMIT = 10000

const POSITION = /^(.+?):(\d+):(\d+):\s(.*)$/

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const KEEP = /^\s*(#!|\/\/\s*(go:|nolint|lint:|@ts-|eslint|prettier|biome)|#\s*(noqa|type:|pylint|mypy|ruff:|fmt:)|#region|(\/\/|#|--|\*)\s*(TODO|FIXME|HACK|XXX|SAFETY|NOTE:))/

const NARRATION = /^\s*(\/\/+|#+|\*|--)\s*((Step\s+\d)|((Now|Then|First|Next|Finally)[\s,]+(we|create|check|set|get|call|do)\b)|(This\s+(function|method|class|file|module|struct|type|interface|variable|constant|field|block)\b)|((Loop|Loops|Iterate|Iterates)\s+(through|over)\b)|((Sets?|Gets?|Returns?|Creates?|Initializes?|Checks?|Handles?|Updates?|Adds?|Removes?|Calls?|Defines?|Declares?|Parses?|Converts?|Stores?)\s+(the|a|an)\s))/i

const REASON = /\b(because|since|so\s+that|otherwise|instead|to\s+(avoid|keep|make|stop)|workaround|upstream|deliberately|on\s+purpose|must|cannot|would|panics?|races?|deadlocks?|leaks?)\b|:\s+\S/i

const BANNER = /^\s*(\/\/+|#+|\*|--)\s*[-=*_#~]{4,}/

const COMMENT_LINE = /^\s*(\/\/|#|\*|--)/

const dirName = (path: string): string => {
  const cut = path.lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut)
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot)
}

const under = (path: string, root: string): string | null =>
  path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null

const run = async (
  $: EngineInterface,
  argv: readonly string[],
  init?: RunInit,
): Promise<RunResult | null> => {
  try {
    return await $.process.run(argv, init)
  } catch {
    return null
  }
}

const findUp = async ($: EngineInterface, from: string, marker: string): Promise<string | null> => {
  let dir = from
  while (dir !== "/" && dir !== "") {
    if (await $.fs.exists(`${dir}/${marker}`)) return dir
    dir = dirName(dir)
  }
  return null
}

const parsePosition = (line: string): Issue | null => {
  const match = POSITION.exec(line)
  if (match === null) return null
  return { line: Number(match[2]), column: Number(match[3]), text: match[4] ?? "" }
}

const positionsIn = (text: string): Issue[] =>
  text
    .split("\n")
    .map((line) => parsePosition(line.trim()))
    .filter((issue): issue is Issue => issue !== null)

const goIssues = async ($: EngineInterface, filePath: string): Promise<Issue[]> => {
  const listed = await run($, ["gofmt", "-l", filePath], { timeoutMs: 15000 })
  if (listed && listed.exitCode === 0 && listed.stdout.trim() !== "") {
    await run($, ["gofmt", "-w", filePath], { timeoutMs: 15000 })
  }

  const dir = dirName(filePath)
  const moduleRoot = await findUp($, dir, "go.mod")

  if (moduleRoot === null) {
    const vet = await run($, ["go", "vet", filePath], { timeoutMs: 40000 })
    if (vet === null || vet.exitCode === 0) return []
    return positionsIn(`${vet.stderr}\n${vet.stdout}`)
  }

  const relative = under(dir, moduleRoot) ?? ""
  const target = relative === "" ? "./" : `./${relative}/`
  const linted = await run(
    $,
    [
      "golangci-lint", "run",
      "--new-from-rev=HEAD",
      "--timeout=25s",
      "--output.json.path", "stdout",
      target,
    ],
    { cwd: moduleRoot, timeoutMs: 60000 },
  )
  if (linted === null) return []

  const head = linted.stdout.split("\n", 1)[0] ?? ""
  let issues: unknown = []
  try {
    issues = (JSON.parse(head) as { Issues?: unknown }).Issues
  } catch {
    return []
  }
  if (!Array.isArray(issues)) return []

  return issues.map((raw) => {
    const issue = raw as { Text?: string; FromLinter?: string; Pos?: { Line?: number; Column?: number } }
    const parts = (issue.Text ?? "").split("\n").map((part) => part.trim()).filter((part) => part !== "")
    const stated = (parts[parts.length - 1] ?? "").replace(/^:\s*/, "")
    const inner = parsePosition(stated)
    return {
      line: inner?.line ?? issue.Pos?.Line ?? 0,
      column: inner?.column ?? issue.Pos?.Column ?? 0,
      text: `${inner?.text ?? stated} (${issue.FromLinter ?? "golangci-lint"})`,
    }
  })
}

let ruffArgv: readonly string[] | null | undefined

const resolveRuff = async ($: EngineInterface): Promise<readonly string[] | null> => {
  if (ruffArgv !== undefined) return ruffArgv
  for (const candidate of [["ruff"], ["uvx", "ruff"]]) {
    const probe = await run($, [...candidate, "--version"], { timeoutMs: 30000 })
    if (probe !== null && probe.exitCode === 0) {
      ruffArgv = candidate
      return ruffArgv
    }
  }
  ruffArgv = null
  return null
}

const pythonIssues = async ($: EngineInterface, filePath: string): Promise<Issue[]> => {
  const argv = await resolveRuff($)
  if (argv === null) return []

  await run($, [...argv, "format", filePath], { timeoutMs: 40000 })
  const checked = await run($, [...argv, "check", "--output-format", "concise", filePath], { timeoutMs: 40000 })
  if (checked === null) return []

  return positionsIn(checked.stdout)
}

const formatJava = async ($: EngineInterface, filePath: string): Promise<void> => {
  await run($, ["google-java-format", "-i", filePath], { timeoutMs: 40000 })
}

const addedLines = async ($: EngineInterface, filePath: string): Promise<AddedLine[]> => {
  const dir = dirName(filePath)
  const root = await run($, ["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10000 })

  if (root !== null && root.exitCode === 0) {
    const repo = root.stdout.trim()
    const tracked = await run($, ["git", "-C", repo, "ls-files", "--error-unmatch", filePath], { cwd: dir, timeoutMs: 10000 })
    if (tracked !== null && tracked.exitCode === 0) {
      const diff = await run($, ["git", "-C", repo, "diff", "-U0", "HEAD", "--", filePath], { cwd: dir, timeoutMs: 20000 })
      if (diff === null) return []

      const added: AddedLine[] = []
      let line = 0
      for (const row of diff.stdout.split("\n")) {
        const hunk = HUNK.exec(row)
        if (hunk !== null) {
          line = Number(hunk[1])
          continue
        }
        if (row.startsWith("+++")) continue
        if (row.startsWith("+")) {
          added.push({ line, text: row.slice(1) })
          line += 1
        }
      }
      return added
    }
  }

  const text = await $.fs.read(filePath).catch(() => "")
  return text.split("\n").map((row, index) => ({ line: index + 1, text: row }))
}

const commentIssues = async ($: EngineInterface, filePath: string): Promise<Issue[]> => {
  const candidates = (await addedLines($, filePath)).filter((one) => !KEEP.test(one.text))
  if (candidates.length === 0) return []

  const issues: Issue[] = []

  const narrated = candidates.filter((one) => NARRATION.test(one.text) && !REASON.test(one.text))
  for (const one of narrated.slice(0, 8)) {
    issues.push({
      line: one.line,
      column: 1,
      text: `comment restates the code — delete it or replace it with the reason: ${one.text.trim()}`,
    })
  }

  for (const one of candidates.filter((one) => BANNER.test(one.text)).slice(0, 4)) {
    issues.push({ line: one.line, column: 1, text: `section-divider banner — remove it: ${one.text.trim()}` })
  }

  let streak = 0
  let opened = 0
  let previous = 0
  for (const one of candidates) {
    if (COMMENT_LINE.test(one.text) && (streak === 0 || one.line === previous + 1)) {
      if (streak === 0) opened = one.line
      streak += 1
      previous = one.line
      if (streak >= 5) {
        issues.push({
          line: opened,
          column: 1,
          text: "a comment block of 5+ added lines — keep it to one line unless the file already uses long blocks",
        })
        break
      }
      continue
    }
    streak = 0
  }

  return issues.sort((one, other) => one.line - other.line || one.column - other.column)
}

const runChecks = async (
  $: EngineInterface,
  filePath: string,
  label: string,
  name: string,
): Promise<Report | null> => {
  const extension = extensionOf(filePath)
  const issues: Issue[] = []

  if (extension === ".go") issues.push(...(await goIssues($, filePath)))
  else if (extension === ".py") issues.push(...(await pythonIssues($, filePath)))
  else if (extension === ".java") await formatJava($, filePath)

  const comments = CODE_EXTENSIONS.has(extension) ? await commentIssues($, filePath) : []
  issues.push(...comments)

  if (issues.length === 0) return null

  const stated = issues
    .sort((one, other) => one.line - other.line || one.column - other.column)
    .map((issue) => (issue.line === 0 ? `${label}: ${issue.text}` : `${label}:${issue.line}:${issue.column}: ${issue.text}`))
    .join("\n")
  const detail = comments.length === 0 ? stated : `${stated}\n\nComments must state why, not what.`

  return { count: issues.length, name, detail }
}

const reports = new Map<string, Report>()

const summary = (count: number, where: string): string =>
  `${count} lint issue${count === 1 ? "" : "s"} in ${where}`

const remember = (toolUseId: string, report: Report): void => {
  reports.set(toolUseId, report)
  while (reports.size > REPORT_LIMIT) {
    const oldest = reports.keys().next().value
    if (oldest === undefined) break
    reports.delete(oldest)
  }
}

const onFileTool = async (
  $: EngineInterface,
  toolUseId: string,
  filePath: string,
): Promise<string | null> => {
  const cwd = await $.session.cwd().catch(() => "")
  const relative = cwd === "" ? null : under(filePath, cwd)
  const label = relative ?? filePath
  const name = relative ?? baseName(filePath)

  const report = await runChecks($, filePath, label, name)
  if (report === null) return null

  remember(toolUseId, report)
  return report.detail
}

export const register: Register = (on) => {
  on("tool.call", { tool: "Edit" }, async ($, e, next) => {
    const result = await next(e)
    if ("deny" in result || result.isError === true) return result

    const detail = await onFileTool($, e.tool_use_id, e.file_path)
    if (detail === null) return result

    return { ...result, context: [...(result.context ?? []), detail] }
  })

  on("tool.call", { tool: "Write" }, async ($, e, next) => {
    const result = await next(e)
    if ("deny" in result || result.isError === true) return result

    const detail = await onFileTool($, e.tool_use_id, e.file_path)
    if (detail === null) return result

    return { ...result, context: [...(result.context ?? []), detail] }
  })

  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    const report = reports.get(e.props.tool_use_id)
    if (report === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{`⎿  ${summary(report.count, report.name)}`}</Text>
        <Box marginLeft={3}>
          <Text dimColor>{report.detail.slice(0, TEXT_LIMIT)}</Text>
        </Box>
      </Box>
    )
  })

  on("ui.render", { component: "ToolGroup" }, async ($, e, next) => {
    const found = e.props.calls
      .map((call) => (call.tool_use_id === undefined ? undefined : reports.get(call.tool_use_id)))
      .filter((report): report is Report => report !== undefined)
    if (found.length === 0) return next(e)

    const count = found.reduce((total, report) => total + report.count, 0)
    const names = new Set(found.map((report) => report.name))
    const where = names.size === 1 ? (found[0]?.name ?? "") : `${names.size} files`

    const { Box, Text } = $.ui.resolve(e)
    const drawn = await next(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box marginLeft={2}>
          <Text dimColor>{`⎿  ${summary(count, where)} (ctrl+o to expand)`}</Text>
        </Box>
      </Box>
    )
  })
}
