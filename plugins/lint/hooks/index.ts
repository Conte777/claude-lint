import type { EngineInterface, Register } from "claude-code"

type Report = { count: number; file: string; detail: string }

type RunResult = { exitCode: number; stdout: string; stderr: string }

type RunInit = { cwd?: string; timeoutMs?: number }

const CODE_EXTENSIONS = new Set([
  ".go", ".py", ".java", ".kt", ".scala", ".rs", ".rb", ".php", ".swift",
  ".sh", ".bash", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx",
])

const POSITION = /^.+:\d+:\d+: /

const KEEP = /^\+\s*(#!|\/\/\s*(go:|nolint|lint:|@ts-|eslint|prettier|biome)|#\s*(noqa|type:|pylint|mypy|ruff:|fmt:)|#region|(\/\/|#|--|\*)\s*(TODO|FIXME|HACK|XXX|SAFETY|NOTE:))/

const NARRATION = /^\+\s*(\/\/+|#+|\*|--)\s*((Step\s+[0-9])|((Now|Then|First|Next|Finally)[\s,]+(we|create|check|set|get|call|do))|(This\s+(function|method|class|file|module|struct|type|interface|variable|constant|field|block)\s)|((Loop|Loops|Iterate|Iterates)\s+(through|over))|((Set|Sets|Get|Gets|Return|Returns|Create|Creates|Initialize|Initializes|Check|Checks|Handle|Handles|Update|Updates|Add|Adds|Remove|Removes|Call|Calls|Define|Defines|Declare|Declares|Parse|Parses|Convert|Converts|Store|Stores)\s+(the|a|an)\s))/i

const BANNER = /^\+\s*(\/\/+|#+|\*|--)\s*[-=*_#~]{4,}/

const COMMENT_LINE = /^\+\s*(\/\/|#|\*|--)/

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

const relativeTo = (path: string, root: string): string =>
  path === root ? "" : path.slice(root.length + 1)

const goIssues = async ($: EngineInterface, filePath: string): Promise<string[]> => {
  const listed = await run($, ["gofmt", "-l", filePath], { timeoutMs: 15000 })
  if (listed && listed.exitCode === 0 && listed.stdout.trim() !== "") {
    await run($, ["gofmt", "-w", filePath], { timeoutMs: 15000 })
  }

  const dir = dirName(filePath)
  const moduleRoot = await findUp($, dir, "go.mod")

  if (moduleRoot === null) {
    const vet = await run($, ["go", "vet", filePath], { timeoutMs: 40000 })
    if (vet === null || vet.exitCode === 0) return []
    return `${vet.stderr}\n${vet.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => POSITION.test(line))
  }

  const relative = relativeTo(dir, moduleRoot)
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
    const issue = raw as { Text?: string; FromLinter?: string; Pos?: { Filename?: string; Line?: number; Column?: number } }
    const parts = (issue.Text ?? "").split("\n").map((part) => part.trim()).filter((part) => part !== "")
    const text = (parts[parts.length - 1] ?? "").replace(/^:\s*/, "").replace(/^\.\//, "")
    const line = issue.Pos?.Line ?? 0
    const where = line === 0 || POSITION.test(text)
      ? ""
      : `${baseName(issue.Pos?.Filename ?? filePath)}:${line}:${issue.Pos?.Column ?? 0}: `
    return `${where}${text} (${issue.FromLinter ?? "golangci-lint"})`
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

const pythonIssues = async ($: EngineInterface, filePath: string): Promise<string[]> => {
  const argv = await resolveRuff($)
  if (argv === null) return []

  await run($, [...argv, "format", filePath], { timeoutMs: 40000 })
  const checked = await run($, [...argv, "check", "--output-format", "concise", filePath], { timeoutMs: 40000 })
  if (checked === null) return []

  const prefix = `${dirName(filePath)}/`
  return checked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => POSITION.test(line))
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
}

const formatJava = async ($: EngineInterface, filePath: string): Promise<void> => {
  await run($, ["google-java-format", "-i", filePath], { timeoutMs: 40000 })
}

const addedLines = async ($: EngineInterface, filePath: string): Promise<string[]> => {
  const dir = dirName(filePath)
  const root = await run($, ["git", "rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10000 })

  if (root !== null && root.exitCode === 0) {
    const repo = root.stdout.trim()
    const tracked = await run($, ["git", "-C", repo, "ls-files", "--error-unmatch", filePath], { cwd: dir, timeoutMs: 10000 })
    if (tracked !== null && tracked.exitCode === 0) {
      const diff = await run($, ["git", "-C", repo, "diff", "-U0", "HEAD", "--", filePath], { cwd: dir, timeoutMs: 20000 })
      if (diff === null) return []
      return diff.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    }
  }

  const text = await $.fs.read(filePath).catch(() => "")
  return text.split("\n").map((line) => `+${line}`)
}

const commentIssues = async ($: EngineInterface, filePath: string): Promise<string[]> => {
  const candidates = (await addedLines($, filePath)).filter((line) => !KEEP.test(line))
  if (candidates.length === 0) return []

  const file = baseName(filePath)
  const issues: string[] = []

  for (const line of candidates.filter((one) => NARRATION.test(one)).slice(0, 8)) {
    issues.push(`${file}: comment restates the code — delete it or replace it with the reason: ${line.slice(1).trim()}`)
  }
  for (const line of candidates.filter((one) => BANNER.test(one)).slice(0, 4)) {
    issues.push(`${file}: section-divider banner — remove it: ${line.slice(1).trim()}`)
  }

  let streak = 0
  for (const line of candidates) {
    if (COMMENT_LINE.test(line)) {
      streak += 1
      if (streak >= 5) {
        issues.push(`${file}: a comment block of 5+ added lines — keep it to one line unless the file already uses long blocks`)
        break
      }
      continue
    }
    streak = 0
  }

  return issues
}

const runChecks = async ($: EngineInterface, filePath: string): Promise<Report | null> => {
  const extension = extensionOf(filePath)
  const issues: string[] = []

  if (extension === ".go") issues.push(...(await goIssues($, filePath)))
  else if (extension === ".py") issues.push(...(await pythonIssues($, filePath)))
  else if (extension === ".java") await formatJava($, filePath)

  const comments = CODE_EXTENSIONS.has(extension) ? await commentIssues($, filePath) : []
  issues.push(...comments)

  if (issues.length === 0) return null

  const detail = comments.length === 0
    ? issues.join("\n")
    : `${issues.join("\n")}\n\nComments must state why, not what.`

  return { count: issues.length, file: baseName(filePath), detail }
}

const REPORT_LIMIT = 200

const reports = new Map<string, Report>()

const remember = (toolUseId: string, report: Report): void => {
  if (reports.size >= REPORT_LIMIT) {
    const oldest = reports.keys().next()
    if (oldest.done !== true) reports.delete(oldest.value)
  }
  reports.set(toolUseId, report)
}

const recordTouched = async ($: EngineInterface, filePath: string): Promise<void> => {
  const home = await $.env.get("HOME")
  if (home === undefined) return

  const sessionId = await $.session.id()
  const path = `${home}/.claude/.lint-sessions/${sessionId}`
  const previous = (await $.fs.exists(path)) ? await $.fs.read(path).catch(() => "") : ""
  if (previous.split("\n").includes(filePath)) return

  await $.fs.write(path, `${previous}${filePath}\n`)
}

const onFileTool = async (
  $: EngineInterface,
  filePath: string,
  toolUseId: string | undefined,
): Promise<string | null> => {
  await recordTouched($, filePath)

  const report = await runChecks($, filePath)
  if (report === null) return null

  if (toolUseId === undefined) {
    $.ui.log(`${report.count} issues in ${report.file}, no tool_use_id to draw them on`, { to: "debug" })
    return report.detail
  }

  remember(toolUseId, report)
  $.ui.invalidate("ui.render")
  $.ui.log(`${report.count} issues in ${report.file}, redraw asked for ${toolUseId}`, { to: "debug" })
  return report.detail
}

export const register: Register = (on) => {
  on("tool.call", { tool: "Edit" }, async ($, e, next) => {
    const result = await next(e)
    if ("deny" in result || result.isError === true) return result

    const detail = await onFileTool($, e.file_path, e.tool_use_id)
    if (detail === null) return result

    return { ...result, context: [...(result.context ?? []), detail] }
  })

  on("tool.call", { tool: "Write" }, async ($, e, next) => {
    const result = await next(e)
    if ("deny" in result || result.isError === true) return result

    const detail = await onFileTool($, e.file_path, e.tool_use_id)
    if (detail === null) return result

    return { ...result, context: [...(result.context ?? []), detail] }
  })

  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    const drawn = await next(e)
    const report = reports.get(e.props.tool_use_id)
    if (report === undefined) return drawn

    const { Box, Text } = $.ui.resolve(e)
    const plural = report.count === 1 ? "" : "s"

    return Box({
      flexDirection: "column",
      children: [
        drawn,
        Text({ dimColor: true, children: `${report.count} lint issue${plural} in ${report.file}` }),
      ],
    })
  })
}
