export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" })
  }

  let code = req.body?.code
  if (typeof code !== "string") {
    return res.status(400).json({ error: "code must be string" })
  }

  let lines = code.split("\n")

  let stack = []
  let depth = 0
  let maxdepth = 0

  let loopdepth = 0
  let maxloopdepth = 0

  let warnings = []
  let risks = []

  let hasyield = false
  let insidewhile = false
  let whilelines = []

  let tokens = {
    do: 0,
    end: 0,
    function: 0,
    while: 0,
    repeat: 0,
    until: 0
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim()

    if (line === "" || line.startsWith("--")) continue

    if (/\b(task\.wait|task\.spawn|task\.delay|wait)\b/.test(line)) {
      hasyield = true
    }

    if (/\bfunction\b/.test(line)) {
      tokens.function++
      depth++
      stack.push("function")
    }

    if (/\b(do|then|repeat)\b/.test(line)) {
      depth++
      stack.push("block")
    }

    if (/\bwhile\b/.test(line)) {
      tokens.while++
      loopdepth++
      maxloopdepth = Math.max(maxloopdepth, loopdepth)
      insidewhile = true
      whilelines = []
    }

    if (insidewhile) {
      whilelines.push(line)
    }

    if (/\b(end|until)\b/.test(line)) {
      tokens.end++
      depth = Math.max(0, depth - 1)

      let last = stack.pop()
      if (last === "function" && loopdepth > 0) {
        warnings.push("function defined inside loop")
      }

      if (insidewhile && loopdepth > 0) {
        let joined = whilelines.join(" ")
        if (!/\b(task\.wait|task\.spawn|task\.delay|wait)\b/.test(joined)) {
          risks.push("while loop without yield detected")
        }
        insidewhile = false
        loopdepth--
      }
    }

    if (depth > maxdepth) maxdepth = depth

    if (/while\s+true\s+do/.test(line)) {
      risks.push("while true loop detected")
    }
  }

  if (depth !== 0 || stack.length !== 0) {
    risks.push("unbalanced blocks (missing end)")
  }

  if (maxloopdepth >= 2) {
    warnings.push("nested loops detected")
  }

  if (maxdepth >= 6) {
    warnings.push("deep nesting may impact performance")
  }

  if (tokens.while > 0 && !hasyield) {
    risks.push("loops exist but no yield found")
  }

  if (tokens.while >= 5) {
    warnings.push("many while loops detected")
  }

  let crashlikelihood = "low"
  if (risks.length >= 3) crashlikelihood = "high"
  else if (risks.length >= 1) crashlikelihood = "medium"

  res.status(200).json({
    ok: true,
    metrics: {
      lines: lines.length,
      functions: tokens.function,
      loops: tokens.while,
      maxdepth,
      maxloopdepth
    },
    risks,
    warnings,
    crashlikelihood
  })
}
