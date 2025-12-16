export const config = {
  api: {
    bodyParser: false
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("method not allowed")
  }

  let raw = ""
  for await (const chunk of req) raw += chunk
  let code = raw.toString()
  if (!code.trim()) return res.status(400).end("empty body")

  let fixmode = req.query.fix === "true"
  let lines = code.split("\n")

  let blocks = []
  let loops = []
  let functions = []
  let diagnostics = []
  let unreachable = new Set()

  let depth = 0
  let maxdepth = 0
  let complexity = 1
  let lastreturn = false

  function diag(line, severity, msg) {
    diagnostics.push({ line, severity, msg })
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()
    let ln = i + 1

    if (lastreturn && line && !line.startsWith("end")) {
      unreachable.add(ln)
    }
    lastreturn = false

    if (!line || line.startsWith("--")) continue

    if (/\breturn\b/.test(line)) lastreturn = true

    if (/\bfunction\b/.test(line)) {
      depth++
      maxdepth = Math.max(maxdepth, depth)
      complexity++
      functions.push({ line: ln, recursive: false })
      blocks.push("function")
    }

    if (/\bwhile\b|\brepeat\b/.test(line)) {
      depth++
      maxdepth = Math.max(maxdepth, depth)
      complexity++
      loops.push({
        line: ln,
        infinite: /while\s+true\s+do/.test(line),
        yield: false
      })
      blocks.push("loop")
    }

    if (/\b(task\.wait|task\.spawn|task\.delay|wait)\b/.test(line)) {
      let l = loops[loops.length - 1]
      if (l) l.yield = true
    }

    if (/\bend\b|\buntil\b/.test(line)) {
      if (!blocks.pop()) diag(ln, 1, "unbalanced end")
      depth = Math.max(0, depth - 1)
    }
  }

  while (blocks.length) {
    lines.push("end")
    blocks.pop()
  }

  let infiniteanalysis = []
  for (let l of loops) {
    let confidence = 0
    if (l.infinite) confidence += 50
    if (!l.yield) confidence += 40
    confidence = Math.min(100, confidence)
    infiniteanalysis.push({ line: l.line, confidence })
    if (confidence >= 70) {
      diag(l.line, 1, "high probability infinite loop")
    }
  }

  let riskscore =
    infiniteanalysis.filter(l => l.confidence >= 70).length * 30 +
    unreachable.size * 10 +
    (maxdepth >= 7 ? 15 : 0) +
    (complexity >= 15 ? 15 : 0)

  riskscore = Math.min(100, riskscore)

  let verdict = "safe"
  if (riskscore >= 65) verdict = "unsafe"
  else if (riskscore >= 30) verdict = "caution"

  if (!fixmode) {
    return res.status(200).json({
      ok: true,
      verdict,
      metrics: {
        lines: lines.length,
        loops: loops.length,
        functions: functions.length,
        complexity,
        maxdepth,
        riskscore
      },
      infiniteanalysis,
      unreachable: [...unreachable],
      diagnostics
    })
  }

  let fixed = lines.slice()

  for (let l of infiniteanalysis) {
    if (l.confidence >= 70) {
      fixed.splice(l.line, 0, "task.wait()")
    }
  }

  for (let u of unreachable) {
    fixed[u - 1] = "-- unreachable: " + fixed[u - 1]
  }

  let header = [
    "--[[",
    "static analysis report",
    "",
    "verdict: " + verdict,
    "risk score: " + riskscore,
    "complexity: " + complexity,
    "max depth: " + maxdepth,
    "",
    "diagnostics:"
  ]

  for (let d of diagnostics) {
    header.push(`line ${d.line}: ${d.msg}`)
  }

  header.push("", "auto fixes applied:", "- injected yields", "- commented unreachable code", "- balanced blocks", "--]]", "")

  res.status(200).end(header.join("\n") + fixed.join("\n"))
}
